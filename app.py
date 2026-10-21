"""Flask entry point for ShopBrief's project-planning interface and JSON API."""

from __future__ import annotations

from flask import Flask, jsonify, render_template, request
from werkzeug.exceptions import BadRequest, RequestEntityTooLarge

from planner import PlannerValidationError, build_plan


VERSION = "1.0.0"


def create_app(config: dict | None = None) -> Flask:
    """Build an application without opening sockets or storing submitted projects."""
    # I separate app creation from server startup so tests and WSGI use the same setup.
    application = Flask(__name__)
    # Allow every legal field at its maximum UTF-8 length, including four-byte
    # characters, while still bounding malformed or unexpectedly large bodies.
    application.config.update(MAX_CONTENT_LENGTH=18 * 1024)
    if config:
        application.config.update(config)
    application.json.ensure_ascii = False

    @application.after_request
    def response_headers(response):
        """Keep active content local and treat project text only as response data."""
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' data:; connect-src 'self'; font-src 'self'; "
            "object-src 'none'; base-uri 'self'; form-action 'self'; "
            "frame-ancestors 'none'"
        )
        # A shared browser or proxy should not retain submitted planning content.
        if request.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @application.get("/")
    def index():
        """Serve the project workspace; project state belongs to the browser."""
        return render_template("index.html", version=VERSION)

    @application.get("/healthz")
    def healthz():
        """Retain the original service health check and identify this release."""
        return jsonify(service="shopbrief", status="healthy", version=VERSION)

    @application.post("/api/plan")
    def plan():
        """Validate the four project inputs and return a fresh ordered plan."""
        # I check requests here too because a caller can bypass the browser form.
        if not request.is_json:
            return jsonify(message="Send project details as JSON.", errors={"request": "Use the application/json content type."}), 400
        try:
            payload = request.get_json()
        except BadRequest:
            return jsonify(message="The request could not be read.", errors={"request": "Send valid JSON with project fields."}), 400
        # I leave field rules in the planner so every API caller gets the same validation.
        try:
            return jsonify(build_plan(payload))
        except PlannerValidationError as error:
            return jsonify(message=str(error), errors=error.errors), 400

    @application.errorhandler(RequestEntityTooLarge)
    def oversized_request(_error):
        """Return a predictable JSON response when the outer body limit is exceeded."""
        return jsonify(message="The project request is too large.", errors={"request": "Keep the complete request under 18 KiB and use the field limits shown in the form."}), 413

    return application


# WSGI servers import this object; app creation itself has no external effects.
app = create_app()


if __name__ == "__main__":
    # Direct execution is intended for local development. Use the documented
    # WSGI server command or container for a deployed demonstration.
    app.run(host="127.0.0.1", port=5000, debug=False)
