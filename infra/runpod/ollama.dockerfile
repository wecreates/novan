# RunPod / Vast.ai GPU worker — Ollama with pre-loaded models
# Build: docker build -f ollama.dockerfile -t ops-ollama .
# Run:   docker run --gpus all -p 11434:11434 ops-ollama

FROM ollama/ollama:latest

# Copy startup script
COPY runpod-start.sh /runpod-start.sh
RUN chmod +x /runpod-start.sh

# Expose Ollama port
EXPOSE 11434

# Start Ollama server + pull models
CMD ["/runpod-start.sh"]
