/**
 * A migration recipe is the same explicit, data-only ordered step contract as
 * a transformation plan. Materialization performs the plan's full preflight;
 * preview returns those normalized steps and their independent P1 identities.
 */
export {
  prepareAstTransformationPlan as materializeAstMigrationRecipe,
  runAstTransformationPlanPreview as runAstMigrationRecipePreview,
  type AstTransformationPlanInput as AstMigrationRecipe,
} from "./transformation-plan.ts";
