use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ── CLI ──────────────────────────────────────────────────────────────

#[derive(Parser)]
#[command(name = "memory-cli", about = "Memory system CLI client")]
struct Cli {
    /// Server URL
    #[arg(
        long,
        env = "MEMORY_SERVER_URL",
        default_value = "http://localhost:3002"
    )]
    server: String,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Unified cross-layer search
    Search {
        /// Search query
        query: String,
        /// Max results per layer
        #[arg(short, long, default_value = "10")]
        limit: i64,
    },
    /// Perceptual memory (vector/semantic)
    #[command(subcommand)]
    Perceptual(PerceptualCmd),
    /// Rational memory (structured facts)
    #[command(subcommand)]
    Rational(RationalCmd),
    /// Temporal memory (time-series from Quickwit)
    #[command(subcommand)]
    Temporal(TemporalCmd),
    /// Health check
    Health,
}

#[derive(Subcommand)]
enum PerceptualCmd {
    /// Add a perceptual memory
    Add {
        /// Memory content
        content: String,
        /// Source label
        #[arg(short, long)]
        source: Option<String>,
    },
    /// Semantic search
    Search {
        /// Search query
        query: String,
        #[arg(short, long, default_value = "10")]
        limit: i64,
    },
    /// Get by ID
    Get { id: Uuid },
    /// Delete by ID
    Delete { id: Uuid },
}

#[derive(Subcommand)]
enum RationalCmd {
    /// Add a structured fact
    Add {
        #[arg(short, long)]
        subject: String,
        #[arg(short, long)]
        predicate: String,
        #[arg(short, long)]
        object: String,
        #[arg(short, long, default_value = "1.0")]
        confidence: f32,
        #[arg(long)]
        source: Option<String>,
    },
    /// List facts
    List {
        #[arg(short, long)]
        subject: Option<String>,
        #[arg(short, long)]
        predicate: Option<String>,
        #[arg(short, long, default_value = "10")]
        limit: i64,
    },
    /// Get fact by ID
    Get { id: Uuid },
    /// Update a fact
    Update {
        id: Uuid,
        #[arg(short, long)]
        subject: Option<String>,
        #[arg(short, long)]
        predicate: Option<String>,
        #[arg(short, long)]
        object: Option<String>,
        #[arg(short, long)]
        confidence: Option<f32>,
    },
    /// Delete a fact
    Delete { id: Uuid },
}

#[derive(Subcommand)]
enum TemporalCmd {
    /// Query time-series events
    Query {
        #[arg(short, long)]
        query: Option<String>,
        #[arg(long)]
        from: Option<String>,
        #[arg(long)]
        to: Option<String>,
        #[arg(short, long, default_value = "10")]
        limit: i64,
    },
}

// ── Response Types ───────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct PerceptualMemory {
    id: Uuid,
    content: String,
    source: Option<String>,
    created_at: DateTime<Utc>,
    #[allow(dead_code)]
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
struct PerceptualMemoryWithScore {
    id: Uuid,
    content: String,
    source: Option<String>,
    score: f64,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
struct RationalMemory {
    id: Uuid,
    subject: String,
    predicate: String,
    object: String,
    confidence: f32,
    source: Option<String>,
    created_at: DateTime<Utc>,
    #[allow(dead_code)]
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
struct CreatePerceptual {
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}

#[derive(Debug, Serialize)]
struct CreateRational {
    subject: String,
    predicate: String,
    object: String,
    confidence: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}

#[derive(Debug, Serialize)]
struct UpdateRationalReq {
    #[serde(skip_serializing_if = "Option::is_none")]
    subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    predicate: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    object: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    confidence: Option<f32>,
}

#[derive(Debug, Deserialize)]
struct SearchResult {
    perceptual: Vec<PerceptualMemoryWithScore>,
    rational: Vec<RationalMemory>,
}

// ── HTTP Helpers ─────────────────────────────────────────────────────

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::new()
}

fn check_response(resp: reqwest::blocking::Response) -> Result<reqwest::blocking::Response> {
    let status = resp.status();
    if status.is_success() {
        Ok(resp)
    } else {
        let body = resp.text().unwrap_or_default();
        anyhow::bail!("HTTP {status}: {body}")
    }
}

// ── Display Helpers ──────────────────────────────────────────────────

fn print_perceptual(m: &PerceptualMemory) {
    println!("ID:      {}", m.id);
    println!("Content: {}", m.content);
    if let Some(ref s) = m.source {
        println!("Source:  {s}");
    }
    println!("Created: {}", m.created_at);
    println!();
}

fn print_perceptual_scored(m: &PerceptualMemoryWithScore) {
    println!("ID:      {}", m.id);
    println!("Content: {}", m.content);
    println!("Score:   {:.4}", m.score);
    if let Some(ref s) = m.source {
        println!("Source:  {s}");
    }
    println!("Created: {}", m.created_at);
    println!();
}

fn print_rational(m: &RationalMemory) {
    println!("ID:         {}", m.id);
    println!("Subject:    {}", m.subject);
    println!("Predicate:  {}", m.predicate);
    println!("Object:     {}", m.object);
    println!("Confidence: {:.2}", m.confidence);
    if let Some(ref s) = m.source {
        println!("Source:     {s}");
    }
    println!("Created:    {}", m.created_at);
    println!();
}

// ── Main ─────────────────────────────────────────────────────────────

fn main() -> Result<()> {
    let cli = Cli::parse();
    let base = cli.server.trim_end_matches('/');
    let http = client();

    match cli.command {
        Commands::Health => {
            let resp = http
                .get(format!("{base}/health"))
                .send()
                .context("failed to connect to server")?;
            let body = resp.text()?;
            println!("{body}");
        }

        Commands::Search { query, limit } => {
            let resp = check_response(
                http.get(format!("{base}/api/search"))
                    .query(&[("q", &query), ("limit", &limit.to_string())])
                    .send()?,
            )?;
            let result: SearchResult = resp.json()?;
            if !result.perceptual.is_empty() {
                println!("━━━ Perceptual (Semantic) ━━━");
                for m in &result.perceptual {
                    print_perceptual_scored(m);
                }
            }
            if !result.rational.is_empty() {
                println!("━━━ Rational (Facts) ━━━");
                for m in &result.rational {
                    print_rational(m);
                }
            }
            if result.perceptual.is_empty() && result.rational.is_empty() {
                println!("No results found.");
            }
        }

        Commands::Perceptual(cmd) => match cmd {
            PerceptualCmd::Add { content, source } => {
                let resp = check_response(
                    http.post(format!("{base}/api/perceptual"))
                        .json(&CreatePerceptual { content, source })
                        .send()?,
                )?;
                let m: PerceptualMemory = resp.json()?;
                println!("Created:");
                print_perceptual(&m);
            }
            PerceptualCmd::Search { query, limit } => {
                let resp = check_response(
                    http.get(format!("{base}/api/perceptual/search"))
                        .query(&[("q", &query), ("limit", &limit.to_string())])
                        .send()?,
                )?;
                let results: Vec<PerceptualMemoryWithScore> = resp.json()?;
                if results.is_empty() {
                    println!("No results found.");
                } else {
                    for m in &results {
                        print_perceptual_scored(m);
                    }
                }
            }
            PerceptualCmd::Get { id } => {
                let resp = check_response(http.get(format!("{base}/api/perceptual/{id}")).send()?)?;
                let m: PerceptualMemory = resp.json()?;
                print_perceptual(&m);
            }
            PerceptualCmd::Delete { id } => {
                check_response(http.delete(format!("{base}/api/perceptual/{id}")).send()?)?;
                println!("Deleted {id}");
            }
        },

        Commands::Rational(cmd) => match cmd {
            RationalCmd::Add {
                subject,
                predicate,
                object,
                confidence,
                source,
            } => {
                let resp = check_response(
                    http.post(format!("{base}/api/rational"))
                        .json(&CreateRational {
                            subject,
                            predicate,
                            object,
                            confidence,
                            source,
                        })
                        .send()?,
                )?;
                let m: RationalMemory = resp.json()?;
                println!("Created:");
                print_rational(&m);
            }
            RationalCmd::List {
                subject,
                predicate,
                limit,
            } => {
                let mut query_params = vec![("limit", limit.to_string())];
                if let Some(ref s) = subject {
                    query_params.push(("subject", s.clone()));
                }
                if let Some(ref p) = predicate {
                    query_params.push(("predicate", p.clone()));
                }
                let resp = check_response(
                    http.get(format!("{base}/api/rational"))
                        .query(&query_params)
                        .send()?,
                )?;
                let results: Vec<RationalMemory> = resp.json()?;
                if results.is_empty() {
                    println!("No facts found.");
                } else {
                    for m in &results {
                        print_rational(m);
                    }
                }
            }
            RationalCmd::Get { id } => {
                let resp = check_response(http.get(format!("{base}/api/rational/{id}")).send()?)?;
                let m: RationalMemory = resp.json()?;
                print_rational(&m);
            }
            RationalCmd::Update {
                id,
                subject,
                predicate,
                object,
                confidence,
            } => {
                let resp = check_response(
                    http.put(format!("{base}/api/rational/{id}"))
                        .json(&UpdateRationalReq {
                            subject,
                            predicate,
                            object,
                            confidence,
                        })
                        .send()?,
                )?;
                let m: RationalMemory = resp.json()?;
                println!("Updated:");
                print_rational(&m);
            }
            RationalCmd::Delete { id } => {
                check_response(http.delete(format!("{base}/api/rational/{id}")).send()?)?;
                println!("Deleted {id}");
            }
        },

        Commands::Temporal(cmd) => match cmd {
            TemporalCmd::Query {
                query,
                from,
                to,
                limit,
            } => {
                let mut params = vec![("limit", limit.to_string())];
                if let Some(ref q) = query {
                    params.push(("q", q.clone()));
                }
                if let Some(ref f) = from {
                    params.push(("from", f.clone()));
                }
                if let Some(ref t) = to {
                    params.push(("to", t.clone()));
                }
                let resp = check_response(
                    http.get(format!("{base}/api/temporal"))
                        .query(&params)
                        .send()?,
                )?;
                let body: serde_json::Value = resp.json()?;
                println!("{}", serde_json::to_string_pretty(&body)?);
            }
        },
    }

    Ok(())
}
