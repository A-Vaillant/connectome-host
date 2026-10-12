import {
  DEFAULT_RECIPE, clearSavedRecipe, loadRecipeDetailed, loadSavedRecipe,
  saveRecipe, type Recipe,
} from './recipe.js';

/** Select storage before any explicit-recipe snapshot or runtime is created.
 * Resume/reset only consult env/default: a saved recipe cannot redirect them. */
export async function prepareRecipeStartup(options: {
  source: string | null;
  noRecipe: boolean;
  envDataDir?: string;
}): Promise<{ recipe: Recipe; dataDir: string; mode: 'default' | 'loaded' | 'resumed' }> {
  const initialDir = options.envDataDir || './data';
  if (options.noRecipe) {
    clearSavedRecipe(initialDir);
    return { recipe: DEFAULT_RECIPE, dataDir: initialDir, mode: 'default' };
  }
  if (options.source) {
    const { recipe, persistable } = await loadRecipeDetailed(options.source);
    const dataDir = options.envDataDir || recipe.dataDir || './data';
    saveRecipe(dataDir, persistable);
    return { recipe, dataDir, mode: 'loaded' };
  }
  const saved = await loadSavedRecipe(initialDir);
  return { recipe: saved ?? DEFAULT_RECIPE, dataDir: initialDir, mode: saved ? 'resumed' : 'default' };
}
