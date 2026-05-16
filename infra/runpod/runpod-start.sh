#!/bin/bash
# RunPod GPU worker startup — pulls models then serves Ollama
set -e

echo "[runpod-start] Starting Ollama server..."
ollama serve &
OLLAMA_PID=$!

# Wait for server to be ready
echo "[runpod-start] Waiting for Ollama to be ready..."
until curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; do
  sleep 2
done
echo "[runpod-start] Ollama ready."

# Pull required models (only if not cached on volume)
MODELS="${OLLAMA_MODELS:-llama3 nomic-embed-text mistral}"
for MODEL in $MODELS; do
  echo "[runpod-start] Pulling model: $MODEL"
  ollama pull "$MODEL" || echo "[runpod-start] WARN: failed to pull $MODEL"
done

echo "[runpod-start] All models ready. Serving on :11434"

# Keep foreground
wait $OLLAMA_PID
