# MongoDB Atlas Setup

This release is configured to support MongoDB Atlas through `MONGODB_URI`.

Use an Atlas SRV URI in `.env`:

MONGODB_URI=mongodb+srv://USERNAME:PASSWORD@untangled-nexus.j0fmkag.mongodb.net/untangled_its?retryWrites=true&w=majority&appName=untangled-nexus
MONGODB_TLS=true

Do not commit `.env` or Atlas credentials.

The API detects the connection type. TLS is enabled for Atlas and is not forced for local `mongodb://` connections.

The performance index bootstrap is idempotent: if Atlas already has an equivalent index under a different name, it reuses that index instead of failing with `IndexOptionsConflict`. This is important for existing production databases.

Run:

    npm install
    npm run typecheck
    npm test
    npm run dev

Expected storage message after a successful Atlas connection:

    Storage mode: MongoDB

If Atlas rejects the connection, check the Atlas Network Access IP allow-list, database user/password, and the URI.
