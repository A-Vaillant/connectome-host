- Recipes can select persistent storage with top-level `dataDir`: local relative
  paths anchor to the recipe file, URL recipes require absolute local paths,
  and nonempty `DATA_DIR` overrides it. Bare resume and `--no-recipe` keep
  their env/default lookup; this does not isolate cwd-based host configuration.
