function classifyOracleError(status) {
  return status === 401 ? 'hard-stop' : 'soft-skip';
}

module.exports = { classifyOracleError };
