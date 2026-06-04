# syntax=docker/dockerfile:1
FROM debian:bookworm-slim
COPY out/adapter /criteria-adapter-openai
COPY proto /proto
ENTRYPOINT ["/criteria-adapter-openai"]
