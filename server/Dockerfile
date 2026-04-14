FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY target/release/memory-server .
EXPOSE 3002
CMD ["./memory-server"]
