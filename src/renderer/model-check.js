function checkModelVersion(installedModels, recommendedModel) {
  const upToDate = installedModels.some((m) => m.name === recommendedModel);
  return {
    upToDate,
    message: upToDate ? 'Model is up to date.' : `Recommended model "${recommendedModel}" is not installed. Run: ollama pull ${recommendedModel}`,
  };
}

module.exports = { checkModelVersion };
