# ObsidianSharedVault

SharedVault is a serverless, conflict-free collaboration layer for Obsidian. It stores Yjs-compatible operation files inside the vault, keeps local CRDT cache state under .obsidian/cache/{vault-id}/{node-id}/{user-id}/, and applies remote changes later without a dedicated server.

## Current implementation

- Shared operation log in operation-cache/
- Shared node registry in node-registry/
- Shared snapshots in snapshots/
- Non-shared local CRDT cache in .obsidian/cache/
- Manual sync command and background polling sync
- Per-device node ID persisted in plugin data
- A node joins the registry only after it makes a local change
- Expired nodes are evicted on the next local change based on the configured cache TTL

## Settings

Configure these options in the plugin settings:

- User ID: Identifier written to shared operation metadata.
- User ID default: Your OS login name.
- User ID change: Local cache is moved to the new user path when possible.
- Auto sync interval: Polling interval (seconds) used to scan operation-cache/.
- Cache ttl days: Expiration period for inactive node-registry entries.
- Cache ttl eviction timing: Expired nodes are evicted when a node makes its next local edit.

## How to use

1. Install and enable this plugin for all collaborators who edit the shared vault.
2. Open the same vault from each device using your normal shared storage sync.
3. Edit markdown files as usual.
4. Run manual sync when needed from the command palette.

### Commands

- Apply pending shared operations: Manually imports unapplied operations from operation-cache/.
- Show shared node registry: Displays active/expired participant nodes and last sync metadata.
- Rebuild local crdt cache: Recreates local CRDT cache from current markdown files.
- Create shared crdt snapshot: Writes a shared snapshot file under snapshots/.

## Development

1. Install dependencies

    npm install

2. Type-check

    npm run check

3. Build the plugin bundle

    npm run build

4. During development, watch and rebuild automatically

    npm run dev

## Lint

Run lint checks:

```sh
npm run lint
```

Run lint checks with auto-fix:

```sh
npm run lint:fix
```

The lint rules are aligned with the reference plugin and treated as protected project configuration.

## Scripts

This project includes release helper scripts under scripts/.

### Release notes

Generate release notes from git history:

```sh
npm run generate:release-notes
```

This command reads the current version from manifest.json, compares commits with the previous git tag when available, and groups the notes into Added, Fixed, Changed, Removed, and Other.

### Version bump commands

This project follows Semantic Versioning (MAJOR.MINOR.PATCH).

- Major version bump for breaking changes:

```sh
npm run version:major
```

- Minor version bump for new features:

```sh
npm run version:minor
```

- Patch version bump for fixes:

```sh
npm run version:patch
```

These commands update package.json, manifest.json, and versions.json together. The patch command also updates package-lock.json.

## Release workflow

The release workflow is defined in .github/workflows/release-zip.yml.

1. Run `npm run lint`.
2. Run one of the version bump commands.
3. Run `npm run build`.
4. Trigger the GitHub Actions workflow manually.

The workflow will:

- install dependencies with npm ci
- build the plugin
- verify lint passes
- prepare manifest.json, main.js, styles.css, and versions.json for packaging
- upload the packaged files as a workflow artifact
- create the version tag if it does not already exist
- generate release notes from git history
- create build provenance attestations for main.js and styles.css

## Shared vault layout

```text
Vault/
    operation-cache/
        *.json
    node-registry/
        *.json
    snapshots/
        *.snapshot.json
    .obsidian/
        cache/
            {vault-id}/{node-id}/{user-id}/
```

## Notes

- This collaboration model assumes all collaborators who edit the shared vault have this plugin installed and enabled.
- For stable behavior, collaborators should use the same plugin version whenever possible.
- This implementation assumes the markdown files themselves are already synchronized by the underlying shared storage.
- The plugin currently records Yjs incremental updates derived from markdown diffs and replays them by scanning operation-cache/.
- If the local CRDT cache is missing, the plugin seeds it from the current markdown file contents instead of emitting a bootstrap operation.
- Viewing only does not register the node in the shared registry. The node joins node-registry/ when it makes a local edit.
- Cache expiration is configured in days. When a local edit occurs, expired registry entries are removed before the editing node re-registers itself.
