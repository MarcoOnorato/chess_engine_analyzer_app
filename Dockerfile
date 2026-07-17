# Step 1 Builder
FROM python:3.12-slim AS prep
ARG STOCKFISH_BINARY

# Copy entire context
WORKDIR /context
COPY . .

# Find stockfish binary parent path
RUN mkdir -p /temp_stockfish && \
    PARENT_DIR=$(dirname "${STOCKFISH_BINARY}") && \
    cp -r "${PARENT_DIR}" /temp_stockfish/

# Step 2 Final Image
FROM python:3.12-slim

WORKDIR /app

ARG STOCKFISH_BINARY

RUN apt-get update && apt-get install -y \
    gcc \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir flask python-chess

# APP WORKDIR
COPY app.py /app/
COPY analysis_core.py /app/
COPY player_db /app/player_db
COPY templates /app/templates
COPY static /app/static
COPY --from=prep /temp_stockfish/ /app/

ENV STOCKFISH_PATH=/app/${STOCKFISH_BINARY}

# Optional Player DB feature. Enabled by default; the SQLite file lives under
# /app/data — mount a volume there to persist profiles/games across runs.
# Disable entirely with -e PLAYER_DB_ENABLED=0.
ENV PLAYER_DB_PATH=/app/data/player_db.sqlite
RUN mkdir -p /app/data

RUN chmod +x /app/${STOCKFISH_BINARY}

EXPOSE 5000

CMD ["python", "app.py"]
