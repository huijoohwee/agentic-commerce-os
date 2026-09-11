window.addEventListener('offline', () => void showOffline());
window.addEventListener('online', () => {
  showOnline();
  void replayPendingChanges();
});
if (!navigator.onLine) void showOffline();
else void replayPendingChanges();
void registerWebMcp();
if (navigator.onLine) void actions.searchCatalog({ query: '', limit: 100 }, { discover: false }).catch(catalogError);
