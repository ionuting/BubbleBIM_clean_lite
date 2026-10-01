/** Clean Lite stub — no takeoff engine, so scenarios are never evaluated. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useScenarioResults(..._args: unknown[]): { baseline: any; byId: Map<string, any> } {
  return { baseline: null, byId: new Map() };
}
