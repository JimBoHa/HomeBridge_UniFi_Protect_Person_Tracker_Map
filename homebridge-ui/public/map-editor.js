(() => {
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  const PLATFORM = 'UniFiProtectPersonTrackerMap';
  const state = {
    blocks: [],
    config: null,
    map: { width: 1280, height: 720, cameras: [] },
    image: null,
    selectedId: null,
    updateTimer: null,
  };

  const element = (id) => document.getElementById(id);
  const canvas = element('map');
  const ctx = canvas.getContext('2d');

  const fields = {
    name: element('name'),
    host: element('protect-host'),
    username: element('protect-username'),
    password: element('protect-password'),
    poll: element('protect-poll'),
    ignoreTls: element('protect-ignore-tls'),
    file: element('map-file'),
    status: element('status'),
    save: element('save'),
    addCamera: element('add-camera'),
    cameraList: element('camera-list'),
    selectedLabel: element('selected-label'),
  };

  function setStatus(message) {
    fields.status.textContent = message;
  }

  function getConfigBlock() {
    const existing = state.blocks.find((block) => block.platform === PLATFORM) ?? state.blocks[0] ?? {};
    return {
      platform: PLATFORM,
      name: 'Person Tracker Map',
      peopleTtlSeconds: 300,
      ffmpegPath: 'ffmpeg',
      protect: { ignoreTls: false, pollSeconds: 5 },
      ...existing,
    };
  }

  function syncInputsFromConfig() {
    fields.name.value = state.config.name ?? 'Person Tracker Map';
    fields.host.value = state.config.protect?.host ?? '';
    fields.username.value = state.config.protect?.username ?? '';
    fields.password.value = state.config.protect?.password ?? '';
    fields.poll.value = String(state.config.protect?.pollSeconds ?? 5);
    fields.ignoreTls.checked = Boolean(state.config.protect?.ignoreTls);
  }

  function syncConfigFromInputs() {
    state.config.name = fields.name.value.trim() || 'Person Tracker Map';
    state.config.protect = {
      ...(state.config.protect ?? {}),
      host: fields.host.value.trim() || undefined,
      username: fields.username.value.trim() || undefined,
      password: fields.password.value || undefined,
      ignoreTls: fields.ignoreTls.checked,
      pollSeconds: Math.max(2, Number.parseInt(fields.poll.value, 10) || 5),
    };
    state.config.mapConfig = {
      width: state.map.width,
      height: state.map.height,
      cameras: state.map.cameras,
    };
  }

  async function updatePluginConfig() {
    syncConfigFromInputs();
    const nextBlocks = state.blocks.length ? [...state.blocks] : [state.config];
    const index = nextBlocks.findIndex((block) => block.platform === PLATFORM);
    if (index >= 0) {
      nextBlocks[index] = state.config;
    } else {
      nextBlocks.push(state.config);
    }
    state.blocks = await homebridge.updatePluginConfig(nextBlocks);
  }

  function queueUpdate() {
    window.clearTimeout(state.updateTimer);
    state.updateTimer = window.setTimeout(async () => {
      try {
        await updatePluginConfig();
        setStatus('Changes staged. Click Save to write config.');
      } catch (error) {
        setStatus(error.message);
        homebridge.toast.error(error.message, 'Config update failed');
      }
    }, 250);
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Map image could not be loaded'));
      image.src = dataUrl;
    });
  }

  function draw() {
    canvas.width = state.map.width;
    canvas.height = state.map.height;
    ctx.fillStyle = '#f5f6f2';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (state.image) {
      ctx.drawImage(state.image, 0, 0, canvas.width, canvas.height);
    } else {
      ctx.strokeStyle = '#d4d4cc';
      ctx.lineWidth = 1;
      for (let x = 0; x <= canvas.width; x += 80) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
      }
      for (let y = 0; y <= canvas.height; y += 80) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
      }
    }

    for (const camera of state.map.cameras) {
      const selected = camera.id === state.selectedId;
      ctx.fillStyle = selected ? '#dc2626' : '#1d4ed8';
      ctx.beginPath();
      ctx.arc(camera.position.x, camera.position.y, selected ? 10 : 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#111827';
      ctx.font = '14px sans-serif';
      ctx.fillText(camera.name, camera.position.x + 12, camera.position.y - 8);

      if (typeof camera.headingDegrees === 'number') {
        drawHeading(camera.position.x, camera.position.y, camera.headingDegrees, selected ? '#dc2626' : '#1d4ed8');
      }
    }
  }

  function drawHeading(x, y, degrees, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(degrees * Math.PI / 180);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(14, 0);
    ctx.lineTo(42, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(48, 0);
    ctx.lineTo(36, -7);
    ctx.lineTo(36, 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function renderCameraRows() {
    fields.cameraList.textContent = '';
    fields.selectedLabel.textContent = state.selectedId ? 'Click map to place selected camera.' : 'Select a camera, then click map.';

    for (const camera of state.map.cameras) {
      const row = document.createElement('div');
      row.className = `camera-row${camera.id === state.selectedId ? ' selected' : ''}`;

      const fieldGroup = document.createElement('div');
      fieldGroup.className = 'camera-row-fields';

      const idLabel = labeledInput('ID', camera.id, (value) => {
        const next = sanitizeId(value);
        if (next && !state.map.cameras.some((item) => item !== camera && item.id === next)) {
          if (state.selectedId === camera.id) {
            state.selectedId = next;
          }
          camera.id = next;
          queueUpdate();
        }
      });
      const nameLabel = labeledInput('Name', camera.name, (value) => {
        camera.name = value.trim() || camera.id;
        queueUpdate();
        draw();
      });
      const xLabel = labeledNumber('X', camera.position.x, (value) => {
        camera.position.x = clamp(value, 0, state.map.width);
        queueUpdate();
        draw();
      });
      const yLabel = labeledNumber('Y', camera.position.y, (value) => {
        camera.position.y = clamp(value, 0, state.map.height);
        queueUpdate();
        draw();
      });
      const headingLabel = labeledNumber('Heading', camera.headingDegrees ?? '', (value) => {
        camera.headingDegrees = Number.isFinite(value) ? clamp(value, 0, 359.999) : undefined;
        queueUpdate();
        draw();
      });

      fieldGroup.append(idLabel, nameLabel, xLabel, yLabel, headingLabel);

      const actions = document.createElement('div');
      actions.className = 'camera-row-actions';
      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'btn btn-secondary';
      select.textContent = 'Select';
      select.addEventListener('click', () => {
        state.selectedId = camera.id;
        renderCameraRows();
        draw();
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-danger';
      remove.textContent = 'Delete';
      remove.addEventListener('click', () => {
        state.map.cameras = state.map.cameras.filter((item) => item !== camera);
        if (state.selectedId === camera.id) {
          state.selectedId = state.map.cameras[0]?.id ?? null;
        }
        renderCameraRows();
        draw();
        queueUpdate();
      });
      actions.append(select, remove);
      row.append(fieldGroup, actions);
      fields.cameraList.append(row);
    }
  }

  function labeledInput(label, value, onChange) {
    const wrapper = document.createElement('label');
    const span = document.createElement('span');
    const input = document.createElement('input');
    span.textContent = label;
    input.className = 'form-control';
    input.value = value;
    input.addEventListener('input', () => onChange(input.value));
    wrapper.append(span, input);
    return wrapper;
  }

  function labeledNumber(label, value, onChange) {
    const wrapper = document.createElement('label');
    const span = document.createElement('span');
    const input = document.createElement('input');
    span.textContent = label;
    input.className = 'form-control';
    input.type = 'number';
    input.step = '1';
    input.value = String(value);
    input.addEventListener('input', () => onChange(Number.parseFloat(input.value)));
    wrapper.append(span, input);
    return wrapper;
  }

  function sanitizeId(value) {
    return value.trim().replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 128);
  }

  function clamp(value, min, max) {
    if (!Number.isFinite(value)) {
      return min;
    }
    return Math.max(min, Math.min(max, value));
  }

  fields.file.addEventListener('change', async () => {
    const file = fields.file.files?.[0];
    if (!file) {
      return;
    }
    if (!['image/png', 'image/jpeg'].includes(file.type)) {
      homebridge.toast.error('Choose a PNG or JPEG image.', 'Unsupported file');
      fields.file.value = '';
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      homebridge.toast.error('Map image must be 10 MB or smaller.', 'File too large');
      fields.file.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const dataUrl = String(reader.result);
        const image = await loadImage(dataUrl);
        state.image = image;
        state.config.mapImageData = dataUrl;
        state.map.width = Math.min(10000, image.naturalWidth || image.width);
        state.map.height = Math.min(10000, image.naturalHeight || image.height);
        for (const camera of state.map.cameras) {
          camera.position.x = clamp(camera.position.x, 0, state.map.width);
          camera.position.y = clamp(camera.position.y, 0, state.map.height);
        }
        draw();
        queueUpdate();
      } catch (error) {
        homebridge.toast.error(error.message, 'Image load failed');
      }
    };
    reader.readAsDataURL(file);
  });

  fields.addCamera.addEventListener('click', () => {
    const number = state.map.cameras.length + 1;
    const id = `camera-${number}`;
    const camera = {
      id,
      name: `Camera ${number}`,
      position: { x: Math.round(state.map.width / 2), y: Math.round(state.map.height / 2) },
    };
    state.map.cameras.push(camera);
    state.selectedId = id;
    renderCameraRows();
    draw();
    queueUpdate();
  });

  canvas.addEventListener('click', (event) => {
    const camera = state.map.cameras.find((item) => item.id === state.selectedId);
    if (!camera) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    camera.position.x = Math.round((event.clientX - rect.left) * (canvas.width / rect.width));
    camera.position.y = Math.round((event.clientY - rect.top) * (canvas.height / rect.height));
    renderCameraRows();
    draw();
    queueUpdate();
  });

  for (const input of [fields.name, fields.host, fields.username, fields.password, fields.poll, fields.ignoreTls]) {
    input.addEventListener('input', queueUpdate);
    input.addEventListener('change', queueUpdate);
  }

  fields.save.addEventListener('click', async () => {
    try {
      homebridge.showSpinner();
      await updatePluginConfig();
      await homebridge.savePluginConfig();
      setStatus('Saved. Restart Homebridge for plugin runtime to load new map.');
      homebridge.toast.success('Map and camera placements saved.', 'Saved');
    } catch (error) {
      setStatus(error.message);
      homebridge.toast.error(error.message, 'Save failed');
    } finally {
      homebridge.hideSpinner();
    }
  });

  async function init() {
    try {
      homebridge.showSpinner();
      state.blocks = await homebridge.getPluginConfig();
      state.config = getConfigBlock();
      state.map = state.config.mapConfig ?? { width: 1280, height: 720, cameras: [] };
      state.map.cameras = Array.isArray(state.map.cameras) ? state.map.cameras : [];
      state.selectedId = state.map.cameras[0]?.id ?? null;
      if (state.config.mapImageData) {
        state.image = await loadImage(state.config.mapImageData);
      }
      syncInputsFromConfig();
      renderCameraRows();
      draw();
      setStatus('Ready');
      await updatePluginConfig();
    } catch (error) {
      setStatus(error.message);
      homebridge.toast.error(error.message, 'Plugin UI failed');
    } finally {
      homebridge.hideSpinner();
    }
  }

  init();
})();
