document.addEventListener('DOMContentLoaded', () => {
  chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (settings) => {
    if (!settings) return;
    document.getElementById('threads').value = settings.maxThreads || 3;
    document.getElementById('retries').value = settings.retryCount || 3;
    document.getElementById('delay').value = settings.delayBetweenImages || 800;
    document.getElementById('numberImages').checked = settings.numberImages || false;
    document.getElementById('saveAsCbz').checked = settings.saveAsCbz || false;
    document.getElementById('downloadOriginal').checked = settings.downloadOriginal || false;
    document.getElementById('savePageLinks').checked = settings.savePageLinks !== false;
    document.getElementById('replaceChars').checked = settings.replaceDangerChars !== false;
  });

  document.getElementById('saveBtn').addEventListener('click', () => {
    const settings = {
      numberImages: document.getElementById('numberImages').checked,
      numberSeparator: ': ',
      maxThreads: Math.min(parseInt(document.getElementById('threads').value) || 3, 5),
      retryCount: parseInt(document.getElementById('retries').value) || 3,
      delayBetweenImages: Math.max(parseInt(document.getElementById('delay').value) || 800, 300),
      saveAsCbz: document.getElementById('saveAsCbz').checked,
      downloadOriginal: document.getElementById('downloadOriginal').checked,
      autoStart: false,
      replaceDangerChars: document.getElementById('replaceChars').checked,
      savePageLinks: document.getElementById('savePageLinks').checked,
      smartThrottle: true,
      maxDelay: 15000,
      banPauseMinutes: 5,
    };

    chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: settings }, (resp) => {
      const status = document.getElementById('status');
      if (resp && resp.ok) {
        status.textContent = 'Settings saved!';
        status.style.color = '#2e6e3a';
        setTimeout(() => { status.textContent = ''; }, 2000);
      } else {
        status.textContent = 'Error saving';
        status.style.color = '#8b2e2e';
      }
    });
  });
});
