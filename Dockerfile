# Keep the POC's small Flask container structure and run the capstone as a separate app.
FROM python:3.13-slim

LABEL org.opencontainers.image.title="ShopBrief"
LABEL org.opencontainers.image.description="A maker project brief and step-by-step action workspace"
LABEL org.opencontainers.image.version="1.0.0"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# A dedicated account keeps the application process away from root privileges.
RUN useradd --create-home --uid 10001 appuser
# I install dependencies before copying app code so source edits can reuse that build layer.
COPY requirements.txt ./
RUN pip install --no-cache-dir --disable-pip-version-check -r requirements.txt

COPY --chown=appuser:appuser app.py planner.py ./
COPY --chown=appuser:appuser templates ./templates
COPY --chown=appuser:appuser static ./static
COPY --chown=appuser:appuser tests ./tests

USER appuser
EXPOSE 5000

# Check the actual HTTP service instead of relying on the process merely existing.
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=12 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5000/healthz', timeout=2)" || exit 1

# I bind within the container; the launch command chooses the host address that publishes this port.
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "2", "--threads", "2", "--access-logfile", "-", "--error-logfile", "-", "app:app"]
