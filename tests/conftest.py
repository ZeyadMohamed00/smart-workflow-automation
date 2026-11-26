import os
import tempfile

import pgserver

srv = pgserver.get_server(tempfile.mkdtemp())
os.environ["DATABASE_URL"] = srv.get_uri().replace("postgresql://", "postgresql+psycopg2://", 1)
os.environ.pop("OPENAI_API_KEY", None)
os.environ.pop("FAULT_RATE", None)
