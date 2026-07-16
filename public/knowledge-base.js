(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) root.KnowledgeBaseUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const ADMIN_KEY_STORAGE = 'kb_admin_key';
  const MAX_FILE_SIZE = 25 * 1024 * 1024;
  const ALLOWED_EXTENSIONS = ['.pdf', '.docx', '.md', '.txt'];

  function parseTags(value) {
    const seen = new Set();
    return String(value || '')
      .split(',')
      .map(tag => tag.trim())
      .filter(tag => {
        const normalized = tag.toLocaleLowerCase();
        if (!tag || seen.has(normalized)) return false;
        seen.add(normalized);
        return true;
      });
  }

  function fileExtension(name) {
    const normalized = String(name || '').toLocaleLowerCase();
    const dot = normalized.lastIndexOf('.');
    return dot >= 0 ? normalized.slice(dot) : '';
  }

  function validateFile(file) {
    if (!file) return { valid: false, error: 'Bitte wählen Sie eine Datei aus.' };
    if (!ALLOWED_EXTENSIONS.includes(fileExtension(file.name))) {
      return { valid: false, error: 'Erlaubt sind PDF-, DOCX-, Markdown- und Textdateien.' };
    }
    if (!Number.isFinite(file.size) || file.size < 0 || file.size > MAX_FILE_SIZE) {
      return { valid: false, error: 'Die Datei darf maximal 25 MB groß sein.' };
    }
    return { valid: true, error: '' };
  }

  function normalizeDocument(document) {
    const source = document && typeof document === 'object' ? document : {};
    const chunkCount = Number(source.chunkCount);
    return {
      id: String(source.id || source.documentId || ''),
      fileName: String(source.fileName || source.name || 'Unbenanntes Dokument'),
      fileType: String(source.fileType || fileExtension(source.fileName) || 'Datei'),
      uploadDate: String(source.uploadDate || source.createdAt || ''),
      chunkCount: Number.isFinite(chunkCount) && chunkCount >= 0 ? chunkCount : 0,
      category: String(source.category || 'Allgemein'),
      tags: Array.isArray(source.tags)
        ? source.tags.map(tag => String(tag)).filter(Boolean)
        : parseTags(source.tags),
    };
  }

  function createAdminHeaders(adminKey, contentType) {
    const headers = { 'x-admin-key': String(adminKey || '') };
    if (contentType) headers['Content-Type'] = contentType;
    return headers;
  }

  function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '0 KB';
    if (value < 1024 * 1024) return Math.max(1, Math.round(value / 1024)) + ' KB';
    return (value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
  }

  function errorMessage(error) {
    if (error && (error.status === 401 || error.status === 403)) {
      return 'Der Admin-Schlüssel ist ungültig oder abgelaufen.';
    }
    if (error && error.status === 413) return 'Die Datei überschreitet die erlaubte Größe.';
    if (error && error.status === 415) return 'Dieser Dateityp wird nicht unterstützt.';
    if (error && error.status >= 500) return 'Der Server konnte die Anfrage nicht verarbeiten.';
    if (error && error.status === 400) return 'Die Anfrage enthält ungültige Angaben.';
    if (error && error.name === 'TypeError') return 'Der Server ist momentan nicht erreichbar.';
    return 'Die Aktion konnte nicht abgeschlossen werden.';
  }

  function extractDocuments(payload) {
    const documents = Array.isArray(payload)
      ? payload
      : payload && Array.isArray(payload.documents)
        ? payload.documents
        : [];
    return documents.map(normalizeDocument);
  }

  const exported = {
    ADMIN_KEY_STORAGE,
    MAX_FILE_SIZE,
    ALLOWED_EXTENSIONS,
    parseTags,
    fileExtension,
    validateFile,
    normalizeDocument,
    createAdminHeaders,
    formatBytes,
    errorMessage,
    extractDocuments,
  };

  if (!root || !root.document) return exported;

  const document = root.document;
  const refs = {};
  const state = {
    adminKey: '',
    selectedFile: null,
    busy: null,
    documents: [],
    loaded: false,
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function cacheRefs() {
    [
      'chatView', 'knowledgeView', 'chatNavButton', 'knowledgeNavButton',
      'kbAccessBadge', 'kbAccessLabel', 'kbLockButton', 'kbAuthPanel',
      'kbAuthForm', 'kbAdminKey', 'kbUnlockButton', 'kbAuthError',
      'kbWorkspace', 'kbNotice', 'kbUploadForm', 'kbDropzone',
      'kbFileInput', 'kbFileMeta', 'kbFileName', 'kbFileSize',
      'kbCategory', 'kbTags', 'kbUploadButton', 'kbRefreshButton',
      'kbRebuildButton', 'kbDocumentCount', 'kbDocumentList',
      'kbListState', 'kbListStateTitle', 'kbListStateText',
    ].forEach(id => { refs[id] = byId(id); });
  }

  function readSessionKey() {
    try {
      return root.sessionStorage.getItem(ADMIN_KEY_STORAGE) || '';
    } catch (error) {
      return '';
    }
  }

  function writeSessionKey(value) {
    try {
      if (value) root.sessionStorage.setItem(ADMIN_KEY_STORAGE, value);
      else root.sessionStorage.removeItem(ADMIN_KEY_STORAGE);
    } catch (error) {}
  }

  function setAuthError(message) {
    refs.kbAuthError.textContent = message || '';
    refs.kbAuthError.hidden = !message;
  }

  function setLocked(locked, message) {
    refs.kbAuthPanel.hidden = !locked;
    refs.kbWorkspace.hidden = locked;
    refs.kbLockButton.hidden = locked;
    refs.kbAccessBadge.classList.toggle('unlocked', !locked);
    refs.kbAccessLabel.textContent = locked ? 'Gesperrt' : 'Sitzung aktiv';
    setAuthError(locked ? message : '');
    if (locked) {
      state.adminKey = '';
      state.loaded = false;
      state.documents = [];
      writeSessionKey('');
      clearSelectedFile();
      refs.kbDocumentList.replaceChildren();
      refs.kbDocumentCount.textContent = '0 Einträge';
    }
  }

  function showAppView(name) {
    const knowledge = name === 'knowledge';
    refs.chatView.classList.toggle('active', !knowledge);
    refs.knowledgeView.classList.toggle('active', knowledge);
    refs.chatNavButton.classList.toggle('active', !knowledge);
    refs.knowledgeNavButton.classList.toggle('active', knowledge);
    refs.chatNavButton.toggleAttribute('aria-current', !knowledge);
    refs.knowledgeNavButton.toggleAttribute('aria-current', knowledge);

    if (knowledge) {
      if (state.adminKey && !state.loaded && !state.busy) loadDocuments().catch(() => {});
      else if (!state.adminKey) refs.kbAdminKey.focus();
    } else {
      const chatInput = byId('inp');
      if (chatInput) chatInput.focus();
    }
  }

  function setNotice(tone, message) {
    refs.kbNotice.replaceChildren();
    refs.kbNotice.dataset.tone = tone || 'info';
    refs.kbNotice.textContent = message || '';
    refs.kbNotice.hidden = !message;
  }

  function setListState(kind, title, text) {
    refs.kbListState.dataset.state = kind;
    refs.kbListStateTitle.textContent = title;
    refs.kbListStateText.textContent = text;
    const spinner = refs.kbListState.querySelector('svg');
    if (spinner) spinner.classList.toggle('kb-spinner', kind === 'loading');
    refs.kbListState.hidden = false;
  }

  function hideListState() {
    refs.kbListState.hidden = true;
  }

  function setBusy(kind) {
    state.busy = kind || null;
    const disabled = Boolean(state.busy);
    refs.kbUnlockButton.disabled = disabled;
    refs.kbAdminKey.disabled = disabled;
    refs.kbFileInput.disabled = disabled;
    refs.kbCategory.disabled = disabled;
    refs.kbTags.disabled = disabled;
    refs.kbRefreshButton.disabled = disabled;
    refs.kbRebuildButton.disabled = disabled;
    refs.kbLockButton.disabled = disabled;
    refs.kbUploadButton.disabled = disabled || !state.selectedFile;
    refs.kbDropzone.classList.toggle('disabled', disabled);
    refs.kbUploadButton.setAttribute('aria-busy', kind === 'uploading' ? 'true' : 'false');
    refs.kbRebuildButton.setAttribute('aria-busy', kind === 'rebuilding' ? 'true' : 'false');
  }

  async function apiRequest(path, options, adminKey) {
    const requestOptions = options || {};
    const key = adminKey === undefined ? state.adminKey : adminKey;
    const headers = Object.assign({}, requestOptions.headers || {}, createAdminHeaders(key));
    const response = await root.fetch('/knowledge-base/' + path, Object.assign({}, requestOptions, { headers }));
    const raw = await response.text();
    let payload = null;
    if (raw) {
      try { payload = JSON.parse(raw); } catch (error) { payload = null; }
    }
    if (!response.ok) {
      const failure = new Error('Knowledge base request failed');
      failure.status = response.status;
      throw failure;
    }
    return payload;
  }

  function formatDate(value) {
    if (!value) return 'Unbekannt';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Unbekannt';
    return new Intl.DateTimeFormat('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(date);
  }

  function createIcon(kind) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const paths = kind === 'trash'
      ? ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6', 'M10 11v5', 'M14 11v5']
      : ['M12 2v20', 'M2 12h20'];
    paths.forEach(data => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', data);
      svg.appendChild(path);
    });
    return svg;
  }

  function appendTextElement(parent, className, text, tagName) {
    const element = document.createElement(tagName || 'span');
    if (className) element.className = className;
    element.textContent = text;
    parent.appendChild(element);
    return element;
  }

  function renderDocuments(documents) {
    refs.kbDocumentList.replaceChildren();
    state.documents = documents;
    refs.kbDocumentCount.textContent = documents.length + (documents.length === 1 ? ' Eintrag' : ' Einträge');

    if (!documents.length) {
      setListState('empty', 'Noch keine Dokumente', 'Laden Sie eine Datei hoch, um die Wissensbasis aufzubauen.');
      return;
    }

    hideListState();
    documents.forEach(item => {
      const row = document.createElement('article');
      row.className = 'kb-document-row';
      row.dataset.documentId = item.id;
      row.setAttribute('role', 'listitem');

      const name = document.createElement('div');
      name.className = 'kb-document-name';
      const title = appendTextElement(name, '', item.fileName, 'strong');
      title.title = item.fileName;
      appendTextElement(name, '', item.fileType + ' · ' + item.chunkCount + ' Segmente');
      row.appendChild(name);

      const category = appendTextElement(row, 'kb-category', item.category || 'Allgemein');
      category.title = item.category || 'Allgemein';

      const tags = document.createElement('div');
      tags.className = 'kb-tags';
      if (item.tags.length) {
        item.tags.slice(0, 3).forEach(tag => {
          const pill = appendTextElement(tags, 'kb-tag', tag);
          pill.title = tag;
        });
      } else {
        appendTextElement(tags, 'kb-muted', 'Keine Tags');
      }
      row.appendChild(tags);

      appendTextElement(row, 'kb-muted', formatDate(item.uploadDate));

      const remove = document.createElement('button');
      remove.className = 'kb-btn icon-only danger';
      remove.type = 'button';
      remove.title = 'Dokument löschen';
      remove.setAttribute('aria-label', item.fileName + ' löschen');
      remove.appendChild(createIcon('trash'));
      remove.addEventListener('click', () => deleteDocument(item, row));
      row.appendChild(remove);

      refs.kbDocumentList.appendChild(row);
    });
  }

  async function loadDocuments(options) {
    const settings = options || {};
    setBusy('loading');
    if (!settings.keepNotice) setNotice('', '');
    setListState('loading', 'Dokumente werden geladen', 'Die aktuelle Wissensbasis wird abgerufen.');
    try {
      const payload = await apiRequest('documents', { method: 'GET' }, settings.adminKey);
      const documents = extractDocuments(payload);
      state.loaded = true;
      renderDocuments(documents);
      return documents;
    } catch (error) {
      state.loaded = false;
      if (error.status === 401 || error.status === 403) {
        setLocked(true, errorMessage(error));
      } else {
        setListState('error', 'Dokumente nicht verfügbar', errorMessage(error));
        setNotice('error', errorMessage(error));
      }
      throw error;
    } finally {
      setBusy(null);
    }
  }

  function setSelectedFile(file) {
    const validation = validateFile(file);
    if (!validation.valid) {
      clearSelectedFile();
      setNotice('error', validation.error);
      return;
    }
    state.selectedFile = file;
    refs.kbFileName.textContent = file.name;
    refs.kbFileSize.textContent = formatBytes(file.size);
    refs.kbFileMeta.hidden = false;
    refs.kbUploadButton.disabled = Boolean(state.busy);
    setNotice('', '');
  }

  function clearSelectedFile() {
    state.selectedFile = null;
    if (refs.kbFileInput) refs.kbFileInput.value = '';
    if (refs.kbFileName) refs.kbFileName.textContent = '';
    if (refs.kbFileSize) refs.kbFileSize.textContent = '';
    if (refs.kbFileMeta) refs.kbFileMeta.hidden = true;
    if (refs.kbUploadButton) refs.kbUploadButton.disabled = true;
  }

  async function unlock(event) {
    event.preventDefault();
    const candidate = refs.kbAdminKey.value;
    if (!candidate) return;
    setAuthError('');
    setBusy('loading');
    refs.kbUnlockButton.setAttribute('aria-busy', 'true');
    try {
      await apiRequest('documents', { method: 'GET' }, candidate);
      state.adminKey = candidate;
      state.loaded = false;
      writeSessionKey(candidate);
      refs.kbAdminKey.value = '';
      setLocked(false);
      await loadDocuments();
    } catch (error) {
      setLocked(true, errorMessage(error));
      refs.kbAdminKey.focus();
    } finally {
      refs.kbUnlockButton.setAttribute('aria-busy', 'false');
      setBusy(null);
    }
  }

  async function uploadDocument(event) {
    event.preventDefault();
    const validation = validateFile(state.selectedFile);
    if (!validation.valid || state.busy) {
      if (!validation.valid) setNotice('error', validation.error);
      return;
    }

    const fileName = state.selectedFile.name;
    const form = new root.FormData();
    form.append('file', state.selectedFile);
    const category = refs.kbCategory.value.trim();
    if (category) form.append('category', category);
    parseTags(refs.kbTags.value).forEach(tag => form.append('tags', tag));

    setBusy('uploading');
    setNotice('working', fileName + ' wird hochgeladen und indexiert.');
    try {
      const result = await apiRequest('add', { method: 'POST', body: form });
      clearSelectedFile();
      refs.kbCategory.value = '';
      refs.kbTags.value = '';
      await loadDocuments({ keepNotice: true });
      const chunks = result && Number(result.chunkCount);
      setNotice('success', fileName + ' wurde hinzugefügt' + (Number.isFinite(chunks) ? ' (' + chunks + ' Segmente).' : '.'));
    } catch (error) {
      if (error.status !== 401 && error.status !== 403) setNotice('error', errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function deleteDocument(item, row) {
    if (state.busy || !item.id) return;
    if (!root.confirm('„' + item.fileName + '“ wirklich aus der Wissensbasis löschen?')) return;
    setBusy('deleting');
    row.dataset.busy = 'true';
    setNotice('working', item.fileName + ' wird gelöscht.');
    try {
      await apiRequest('document', {
        method: 'DELETE',
        headers: createAdminHeaders(state.adminKey, 'application/json'),
        body: JSON.stringify({ documentId: item.id }),
      });
      await loadDocuments({ keepNotice: true });
      setNotice('success', item.fileName + ' wurde gelöscht.');
    } catch (error) {
      if (error.status !== 401 && error.status !== 403) setNotice('error', errorMessage(error));
    } finally {
      row.dataset.busy = 'false';
      setBusy(null);
    }
  }

  async function rebuildIndex() {
    if (state.busy) return;
    if (!root.confirm('Den Suchindex aus allen vorhandenen Dokumenten neu aufbauen?')) return;
    setBusy('rebuilding');
    setNotice('working', 'Der Suchindex wird neu aufgebaut. Dies kann einige Minuten dauern.');
    try {
      const result = await apiRequest('rebuild', {
        method: 'POST',
        headers: createAdminHeaders(state.adminKey, 'application/json'),
        body: '{}',
      });
      const processed = result && Number(result.documentsProcessed);
      setNotice(
        'success',
        Number.isFinite(processed)
          ? 'Index erfolgreich neu aufgebaut: ' + processed + ' Dokumente verarbeitet.'
          : 'Der Index wurde erfolgreich neu aufgebaut.',
      );
      await loadDocuments({ keepNotice: true });
    } catch (error) {
      if (error.status !== 401 && error.status !== 403) setNotice('error', errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  function bindEvents() {
    refs.chatNavButton.addEventListener('click', () => showAppView('chat'));
    refs.knowledgeNavButton.addEventListener('click', () => showAppView('knowledge'));
    refs.kbAuthForm.addEventListener('submit', unlock);
    refs.kbLockButton.addEventListener('click', () => {
      setLocked(true);
      refs.kbAdminKey.focus();
    });
    refs.kbUploadForm.addEventListener('submit', uploadDocument);
    refs.kbFileInput.addEventListener('change', event => setSelectedFile(event.target.files[0]));
    refs.kbRefreshButton.addEventListener('click', () => {
      if (!state.busy) loadDocuments().catch(() => {});
    });
    refs.kbRebuildButton.addEventListener('click', rebuildIndex);

    ['dragenter', 'dragover'].forEach(type => {
      refs.kbDropzone.addEventListener(type, event => {
        event.preventDefault();
        if (!state.busy) refs.kbDropzone.classList.add('dragging');
      });
    });
    ['dragleave', 'drop'].forEach(type => {
      refs.kbDropzone.addEventListener(type, event => {
        event.preventDefault();
        refs.kbDropzone.classList.remove('dragging');
      });
    });
    refs.kbDropzone.addEventListener('drop', event => {
      if (!state.busy) setSelectedFile(event.dataTransfer && event.dataTransfer.files[0]);
    });
  }

  function init() {
    cacheRefs();
    if (!refs.knowledgeView) return;
    bindEvents();
    state.adminKey = readSessionKey();
    setLocked(!state.adminKey);
    root.showAppView = showAppView;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  return exported;
});
