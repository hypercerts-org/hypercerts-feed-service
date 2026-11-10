# Development

You need Node.js 22.19+ and PostgreSQL 16+. The minimum Node.js version matches the `undici_v8` dependency used by service authentication.

```bash
npm install
npm run lint
npm run format:check
npm run check
npm run test:unit
npm run build
```

The committed project Lexicons in `lexicons/` define the public wire contract. `lexicons.json` pins active external Lexicon dependencies by AT-URI and CID; it currently includes `com.atproto.repo.strongRef`. The previously installed `app.bsky.actor.profile.json` file is intentionally preserved but is no longer an active dependency or used for identity hydration. The generated TypeScript in `src/lexicons/` is ignored. Do not edit or commit it. The `codegen`, `check`, test, and build commands regenerate it; `npm run lint` also does so through its `prelint` hook before typed linting. Codegen stages only the standard `org.hypercerts.defs#uri`, `#smallBlob`, `#smallImage`, and `#largeImage` fragments from the pinned `@hypercerts-org/lexicon` package. This keeps the feed from committing duplicate definitions. `npm run lint:fix` applies ESLint autofixes, and `npm run format` formats maintained TypeScript, MJS, Markdown, YAML, project configuration, and project-owned feed Lexicons. Generated and externally pinned Lexicons, the lockfile, and release changelogs are excluded. `AGENTS.md` explains a small, focused workaround for the current `@atproto/lex` generator output that runs after codegen.

Check the committed network Lexicons against the manifest with:

```bash
npx --no-install lex install --ci --lexicons ./lexicons --manifest ./lexicons.json
```

Run `lex install --update` only when you mean to update those pinned dependencies.

The main feed statement is `src/feed/feed-query.sql`. `src/feed/query.ts` registers its Hypercerts feed definition, while `src/feed/registry.ts` and `src/feed/sql-feed.ts` own dispatch and shared SQL-feed execution policy. During development, the watcher watches the SQL along with the TypeScript source. The build copies it next to `dist/feed/query.js` before checking that the production adapters load.

## PostgreSQL integration tests

Integration tests need a PostgreSQL 16+ database that you explicitly choose and that is empty and safe to discard:

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/hypercerts_feed_test' \
  npm run test:integration
```

The test suite creates the smallest needed contract tables and test rows. It does not drop or empty existing tables. Never point it at a shared, staging, or production database.

To test against HappyView's migrated schema, use a separate disposable database with no application rows:

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/happyview_feed_test' \
  npm run test:integration:happyview
```

This command needs `psql`. It checks the HappyView columns used by the service, then runs the behavior suite, which inserts synthetic feed records and label rows. It does not apply HappyView migrations or prove that real records or labels have been ingested. Do not point it at a shared, staging, or production database. The suite has no supported label-import path; HappyView's label stream uses standard web PKI roots, so a self-signed local mock labeler cannot populate labels through the real subscription.

## Releases

See [RELEASING.md](RELEASING.md) for when to add a Changeset and how releases are cut.
