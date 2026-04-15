use anyhow::Result;
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{delete, get, post, put},
};
use chrono::{DateTime, Utc};
use clap::{Parser, Subcommand};
use pgvector::Vector;
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use uuid::Uuid;

// ── CLI ──────────────────────────────────────────────────────────────

#[derive(Parser)]
#[command(name = "memory-server", about = "Memory system server")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Start the API server (default)
    Serve {
        #[arg(long, env = "LISTEN_ADDR", default_value = "0.0.0.0:3002")]
        listen: String,
    },
    /// Run consolidation (for CronJob)
    Consolidate,
}

// ── App State ────────────────────────────────────────────────────────

#[derive(Clone)]
struct AppState {
    db: PgPool,
    ollama_url: String,
    ollama_model: String,
    quickwit_url: String,
    embedding_dim: u32,
}

// ── Models ───────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
struct PerceptualMemory {
    id: Uuid,
    content: String,
    source: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PerceptualMemoryWithScore {
    id: Uuid,
    content: String,
    source: Option<String>,
    score: f64,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
struct CreatePerceptual {
    content: String,
    #[serde(default)]
    source: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
struct RationalMemory {
    id: Uuid,
    subject: String,
    predicate: String,
    object: String,
    confidence: f32,
    source: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
struct CreateRational {
    subject: String,
    predicate: String,
    object: String,
    #[serde(default = "default_confidence")]
    confidence: f32,
    #[serde(default)]
    source: Option<String>,
}

fn default_confidence() -> f32 {
    1.0
}

#[derive(Debug, Deserialize)]
struct UpdateRational {
    subject: Option<String>,
    predicate: Option<String>,
    object: Option<String>,
    confidence: Option<f32>,
}

#[derive(Debug, Deserialize)]
struct SearchQuery {
    q: String,
    #[serde(default = "default_limit")]
    limit: i64,
}

fn default_limit() -> i64 {
    10
}

#[derive(Debug, Deserialize)]
struct RationalFilter {
    #[serde(default)]
    subject: Option<String>,
    #[serde(default)]
    predicate: Option<String>,
    #[serde(default = "default_limit")]
    limit: i64,
}

#[derive(Debug, Deserialize)]
struct TemporalQuery {
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    from: Option<String>,
    #[serde(default)]
    to: Option<String>,
    #[serde(default = "default_limit")]
    limit: i64,
}

#[derive(Debug, Serialize)]
struct SearchResult {
    perceptual: Vec<PerceptualMemoryWithScore>,
    rational: Vec<RationalMemory>,
}

// ── Ollama Client ────────────────────────────────────────────────────

async fn embed_text(state: &AppState, text: &str) -> Result<Vec<f32>> {
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/api/embed", state.ollama_url))
        .json(&serde_json::json!({
            "model": state.ollama_model,
            "input": text
        }))
        .send()
        .await?
        .error_for_status()?;
    let body: serde_json::Value = resp.json().await?;
    let embeddings = body["embeddings"][0]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("invalid embedding response"))?
        .iter()
        .map(|v| v.as_f64().unwrap_or(0.0) as f32)
        .collect();
    Ok(embeddings)
}

// ── Quickwit Client ──────────────────────────────────────────────────

async fn query_quickwit(state: &AppState, params: &TemporalQuery) -> Result<serde_json::Value> {
    let client = reqwest::Client::new();
    let query = params.q.clone().unwrap_or_else(|| "*".to_string());
    let mut search_body = serde_json::json!({
        "query": query,
        "max_hits": params.limit,
        "sort_by": "-timestamp_nanos",
    });
    if let Some(ref from) = params.from {
        // Parse ISO 8601 to epoch seconds for Quickwit
        if let Ok(dt) = from.parse::<DateTime<Utc>>() {
            search_body["start_timestamp"] = serde_json::json!(dt.timestamp());
        } else if let Ok(ts) = from.parse::<i64>() {
            search_body["start_timestamp"] = serde_json::json!(ts);
        }
    }
    if let Some(ref to) = params.to {
        if let Ok(dt) = to.parse::<DateTime<Utc>>() {
            search_body["end_timestamp"] = serde_json::json!(dt.timestamp());
        } else if let Ok(ts) = to.parse::<i64>() {
            search_body["end_timestamp"] = serde_json::json!(ts);
        }
    }
    let resp = client
        .post(format!(
            "{}/api/v1/otel-logs-v0_7/search",
            state.quickwit_url
        ))
        .json(&search_body)
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        anyhow::bail!("quickwit query failed ({}): {}", status, text);
    }
    let body: serde_json::Value = resp.json().await?;
    Ok(body)
}

// ── Database Init ────────────────────────────────────────────────────

async fn init_db(pool: &PgPool, embedding_dim: u32) -> Result<()> {
    sqlx::query("CREATE EXTENSION IF NOT EXISTS vector")
        .execute(pool)
        .await?;

    sqlx::query(&format!(
        r#"
        CREATE TABLE IF NOT EXISTS perceptual_memories (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            content TEXT NOT NULL,
            embedding vector({embedding_dim}),
            source TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        "#,
    ))
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS rational_memories (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            subject TEXT NOT NULL,
            predicate TEXT NOT NULL,
            object TEXT NOT NULL,
            confidence REAL NOT NULL DEFAULT 1.0,
            source TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        "#,
    )
    .execute(pool)
    .await?;

    // Create vector index if not exists (ignore error if already exists)
    let _ = sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_perceptual_embedding ON perceptual_memories USING hnsw (embedding vector_cosine_ops)",
    )
    .execute(pool)
    .await;

    tracing::info!("database initialized");
    Ok(())
}

// ── Handlers: Perceptual ─────────────────────────────────────────────

type ApiError = (StatusCode, String);
type ApiResult<T> = Result<T, ApiError>;

async fn create_perceptual(
    State(state): State<Arc<AppState>>,
    Json(input): Json<CreatePerceptual>,
) -> ApiResult<(StatusCode, Json<PerceptualMemory>)> {
    let embedding = embed_text(&state, &input.content).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("embedding failed: {e}"),
        )
    })?;
    let vec = Vector::from(embedding);
    let row = sqlx::query_as::<_, PerceptualMemory>(
        "INSERT INTO perceptual_memories (content, embedding, source) VALUES ($1, $2, $3) RETURNING id, content, source, created_at, updated_at",
    )
    .bind(&input.content)
    .bind(&vec)
    .bind(&input.source)
    .fetch_one(&state.db)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok((StatusCode::CREATED, Json(row)))
}

async fn search_perceptual(
    State(state): State<Arc<AppState>>,
    Query(params): Query<SearchQuery>,
) -> ApiResult<Json<Vec<PerceptualMemoryWithScore>>> {
    let embedding = embed_text(&state, &params.q).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("embedding failed: {e}"),
        )
    })?;
    let vec = Vector::from(embedding);
    let rows = sqlx::query_as::<_, (Uuid, String, Option<String>, f64, DateTime<Utc>)>(
        "SELECT id, content, source, 1 - (embedding <=> $1) AS score, created_at FROM perceptual_memories ORDER BY embedding <=> $1 LIMIT $2",
    )
    .bind(&vec)
    .bind(params.limit)
    .fetch_all(&state.db)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let results: Vec<PerceptualMemoryWithScore> = rows
        .into_iter()
        .map(
            |(id, content, source, score, created_at)| PerceptualMemoryWithScore {
                id,
                content,
                source,
                score,
                created_at,
            },
        )
        .collect();
    Ok(Json(results))
}

async fn get_perceptual(
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<PerceptualMemory>> {
    let row = sqlx::query_as::<_, PerceptualMemory>(
        "SELECT id, content, source, created_at, updated_at FROM perceptual_memories WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    match row {
        Some(m) => Ok(Json(m)),
        None => Err((StatusCode::NOT_FOUND, "not found".to_string())),
    }
}

async fn delete_perceptual(
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let result = sqlx::query("DELETE FROM perceptual_memories WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if result.rows_affected() == 0 {
        Err((StatusCode::NOT_FOUND, "not found".to_string()))
    } else {
        Ok(StatusCode::NO_CONTENT)
    }
}

// ── Handlers: Rational ───────────────────────────────────────────────

async fn create_rational(
    State(state): State<Arc<AppState>>,
    Json(input): Json<CreateRational>,
) -> ApiResult<(StatusCode, Json<RationalMemory>)> {
    let row = sqlx::query_as::<_, RationalMemory>(
        "INSERT INTO rational_memories (subject, predicate, object, confidence, source) VALUES ($1, $2, $3, $4, $5) RETURNING *",
    )
    .bind(&input.subject)
    .bind(&input.predicate)
    .bind(&input.object)
    .bind(input.confidence)
    .bind(&input.source)
    .fetch_one(&state.db)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok((StatusCode::CREATED, Json(row)))
}

async fn list_rational(
    State(state): State<Arc<AppState>>,
    Query(params): Query<RationalFilter>,
) -> ApiResult<Json<Vec<RationalMemory>>> {
    let rows = if let Some(ref subject) = params.subject {
        sqlx::query_as::<_, RationalMemory>(
            "SELECT * FROM rational_memories WHERE subject ILIKE $1 ORDER BY updated_at DESC LIMIT $2",
        )
        .bind(format!("%{subject}%"))
        .bind(params.limit)
        .fetch_all(&state.db)
        .await
    } else if let Some(ref predicate) = params.predicate {
        sqlx::query_as::<_, RationalMemory>(
            "SELECT * FROM rational_memories WHERE predicate ILIKE $1 ORDER BY updated_at DESC LIMIT $2",
        )
        .bind(format!("%{predicate}%"))
        .bind(params.limit)
        .fetch_all(&state.db)
        .await
    } else {
        sqlx::query_as::<_, RationalMemory>(
            "SELECT * FROM rational_memories ORDER BY updated_at DESC LIMIT $1",
        )
        .bind(params.limit)
        .fetch_all(&state.db)
        .await
    };
    rows.map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

async fn get_rational(
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<RationalMemory>> {
    let row = sqlx::query_as::<_, RationalMemory>("SELECT * FROM rational_memories WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    match row {
        Some(m) => Ok(Json(m)),
        None => Err((StatusCode::NOT_FOUND, "not found".to_string())),
    }
}

async fn update_rational(
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
    Json(input): Json<UpdateRational>,
) -> ApiResult<Json<RationalMemory>> {
    let existing =
        sqlx::query_as::<_, RationalMemory>("SELECT * FROM rational_memories WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let existing = match existing {
        Some(m) => m,
        None => return Err((StatusCode::NOT_FOUND, "not found".to_string())),
    };
    let row = sqlx::query_as::<_, RationalMemory>(
        "UPDATE rational_memories SET subject = $1, predicate = $2, object = $3, confidence = $4, updated_at = NOW() WHERE id = $5 RETURNING *",
    )
    .bind(input.subject.unwrap_or(existing.subject))
    .bind(input.predicate.unwrap_or(existing.predicate))
    .bind(input.object.unwrap_or(existing.object))
    .bind(input.confidence.unwrap_or(existing.confidence))
    .bind(id)
    .fetch_one(&state.db)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(row))
}

async fn delete_rational(
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let result = sqlx::query("DELETE FROM rational_memories WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if result.rows_affected() == 0 {
        Err((StatusCode::NOT_FOUND, "not found".to_string()))
    } else {
        Ok(StatusCode::NO_CONTENT)
    }
}

// ── Handlers: Temporal ───────────────────────────────────────────────

async fn query_temporal(
    State(state): State<Arc<AppState>>,
    Query(params): Query<TemporalQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    match query_quickwit(&state, &params).await {
        Ok(data) => Ok(Json(data)),
        Err(e) => Err((
            StatusCode::BAD_GATEWAY,
            format!("quickwit query failed: {e}"),
        )),
    }
}

// ── Handlers: Unified Search ─────────────────────────────────────────

async fn unified_search(
    State(state): State<Arc<AppState>>,
    Query(params): Query<SearchQuery>,
) -> Json<SearchResult> {
    // Semantic search in perceptual layer
    let perceptual = match embed_text(&state, &params.q).await {
        Ok(embedding) => {
            let vec = Vector::from(embedding);
            sqlx::query_as::<_, (Uuid, String, Option<String>, f64, DateTime<Utc>)>(
                "SELECT id, content, source, 1 - (embedding <=> $1) AS score, created_at FROM perceptual_memories ORDER BY embedding <=> $1 LIMIT $2",
            )
            .bind(&vec)
            .bind(params.limit)
            .fetch_all(&state.db)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|(id, content, source, score, created_at)| PerceptualMemoryWithScore {
                id, content, source, score, created_at,
            })
            .collect()
        }
        Err(_) => vec![],
    };

    // Keyword search in rational layer
    let rational = sqlx::query_as::<_, RationalMemory>(
        "SELECT * FROM rational_memories WHERE subject ILIKE $1 OR predicate ILIKE $1 OR object ILIKE $1 ORDER BY updated_at DESC LIMIT $2",
    )
    .bind(format!("%{}%", params.q))
    .bind(params.limit)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    Json(SearchResult {
        perceptual,
        rational,
    })
}

// ── Health ───────────────────────────────────────────────────────────

async fn health(State(state): State<Arc<AppState>>) -> ApiResult<&'static str> {
    sqlx::query("SELECT 1")
        .execute(&state.db)
        .await
        .map_err(|_| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "db unreachable".to_string(),
            )
        })?;
    Ok("ok")
}

// ── Consolidate ──────────────────────────────────────────────────────

async fn run_consolidate(state: &AppState) -> Result<()> {
    tracing::info!("starting consolidation...");

    // Query recent events from Quickwit
    let params = TemporalQuery {
        q: Some("*".to_string()),
        from: None,
        to: None,
        limit: 100,
    };
    let events = query_quickwit(state, &params).await?;
    let hits = events["hits"].as_array().map(|a| a.len()).unwrap_or(0);
    tracing::info!("fetched {hits} events from quickwit");

    // TODO: Call Claude API to extract structured facts from events
    // TODO: Call Ollama to generate embeddings for summaries
    // TODO: Write extracted facts to rational_memories
    // TODO: Write summaries with embeddings to perceptual_memories

    tracing::info!("consolidation complete (stub — implement Claude integration)");
    Ok(())
}

// ── Main ─────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "memory_server=info".parse().unwrap()),
        )
        .init();

    let database_url =
        std::env::var("DATABASE_URL").unwrap_or_else(|_| "postgres://localhost/memory".to_string());
    let ollama_url =
        std::env::var("OLLAMA_URL").unwrap_or_else(|_| "http://localhost:11434".to_string());
    let ollama_model =
        std::env::var("OLLAMA_MODEL").unwrap_or_else(|_| "nomic-embed-text".to_string());
    let embedding_dim: u32 = std::env::var("EMBEDDING_DIM")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1024);
    let quickwit_url =
        std::env::var("QUICKWIT_URL").unwrap_or_else(|_| "http://localhost:7280".to_string());

    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&database_url)
        .await?;

    init_db(&pool, embedding_dim).await?;

    let state = AppState {
        db: pool,
        ollama_url,
        ollama_model,
        quickwit_url,
        embedding_dim,
    };

    let cli = Cli::parse();
    match cli.command.unwrap_or(Command::Serve {
        listen: std::env::var("LISTEN_ADDR").unwrap_or_else(|_| "0.0.0.0:3002".to_string()),
    }) {
        Command::Serve { listen } => {
            let shared = Arc::new(state);
            let app = Router::new()
                .route("/health", get(health))
                .route("/api/search", get(unified_search))
                // Perceptual
                .route("/api/perceptual", post(create_perceptual))
                .route("/api/perceptual/search", get(search_perceptual))
                .route("/api/perceptual/{id}", get(get_perceptual))
                .route("/api/perceptual/{id}", delete(delete_perceptual))
                // Rational
                .route("/api/rational", post(create_rational))
                .route("/api/rational", get(list_rational))
                .route("/api/rational/{id}", get(get_rational))
                .route("/api/rational/{id}", put(update_rational))
                .route("/api/rational/{id}", delete(delete_rational))
                // Temporal
                .route("/api/temporal", get(query_temporal))
                .layer(CorsLayer::permissive())
                .with_state(shared);

            let listener = tokio::net::TcpListener::bind(&listen).await?;
            tracing::info!("listening on {listen}");
            axum::serve(listener, app).await?;
        }
        Command::Consolidate => {
            run_consolidate(&state).await?;
        }
    }

    Ok(())
}
