# Copilot Workspace Instructions

## Protected lint configuration

Do not modify lint configuration files unless the user explicitly asks for it in the current request.

Protected files:
- eslint.config.mjs
- .eslintrc
- .eslintrc.json
- .eslintrc.js
- .eslintrc.cjs
- package.json (scripts section related to lint only)

If a task requires temporary lint validation settings, create temporary files and delete them before finishing.