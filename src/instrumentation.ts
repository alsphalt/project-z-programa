export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { registerNodeWorkers } = await import('./instrumentation.node');
  await registerNodeWorkers();
}
