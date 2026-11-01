# Build from services/executor: docker build -t codesync/executor .
FROM python:3.12-slim AS build
WORKDIR /build
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir --prefix=/install .

FROM python:3.12-slim AS runtime
COPY --from=build /install /usr/local
# Talks to the Docker Engine through a mounted socket, which is root-equivalent on that host. That
# is why this service runs on its own machine, away from the database and secrets.
EXPOSE 9100
CMD ["python", "-m", "executor.worker"]
