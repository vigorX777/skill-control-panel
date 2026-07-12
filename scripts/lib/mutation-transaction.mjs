export async function runMutationTransaction(work) {
  const rollbacks = [];
  const cleanups = [];
  const context = {
    onRollback(step) {
      rollbacks.push(step);
    },
    onCommitCleanup(step) {
      cleanups.push(step);
    },
  };

  try {
    const result = await work(context);
    const cleanupErrors = [];
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error.message);
      }
    }
    return cleanupErrors.length > 0 ? { ...result, cleanupErrors } : result;
  } catch (error) {
    const rollbackErrors = Array.isArray(error.rollbackErrors) ? [...error.rollbackErrors] : [];
    for (const rollback of rollbacks.reverse()) {
      try {
        await rollback();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError.message);
      }
    }
    return {
      ok: false,
      error: error.message,
      rolledBack: rollbackErrors.length === 0,
      rollbackErrors,
    };
  }
}
