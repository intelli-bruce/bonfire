// bf/kit/preview.js — the entry screen's 3D preview: its own small renderer (the world is not loaded yet), the avatar idling and
// turning slowly, drag (or ← →) to turn it by hand. Pauses while hidden. THREE and createAvatar are passed in (one THREE instance).
export function createPreview(THREE, canvas, { createAvatar, reduceMotion = false }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 40);
  scene.add(new THREE.HemisphereLight('#d3dbff', '#8a6a52', 1.55));
  const key = new THREE.DirectionalLight('#fff0dc', 2.5); key.position.set(2.4, 3.6, 3.2); scene.add(key);
  const rim = new THREE.DirectionalLight('#8fa8ff', 1.5); rim.position.set(-3, 2.2, -2.6); scene.add(rim);
  const fire = new THREE.PointLight('#ffa257', 9, 6, 2); fire.position.set(-1.6, 0.7, 1.8); scene.add(fire);   // a warm kick from the bonfire side
  const pivot = new THREE.Group(); scene.add(pivot);

  let av = null, yaw = 0.5, last = 0, raf = 0, running = false, visible = true, dragging = false, idleSince = 0, lastX = 0, reactAt = 0, reactTimer = 0, dist = 5, aimY = 0.8;
  const FOV = 28, HALF = Math.tan((FOV / 2) * Math.PI / 180);

  function fit() {   // whole body in view for any canvas shape (tall phones: limited by the width)
    const w = canvas.clientWidth || 300, h = canvas.clientHeight || 400;
    if (renderer.domElement.width !== Math.round(w * dpr()) || renderer.domElement.height !== Math.round(h * dpr())) { renderer.setPixelRatio(dpr()); renderer.setSize(w, h, false); }
    camera.aspect = w / h;
    const bodyH = (av ? av.headY : 1.6) + 0.3, bodyW = 1.8;   // metres to keep in frame (hair room above; the arms hang down, so a little beside)
    dist = Math.max(bodyH / (2 * HALF), bodyW / (2 * HALF * camera.aspect));
    aimY = (av ? av.headY : 1.6) * 0.5 - 0.02;
    camera.fov = FOV; camera.updateProjectionMatrix();
    camera.position.set(0, aimY + dist * 0.12, dist); camera.lookAt(0, aimY, 0);
  }
  const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

  function setAppearance(ap) {
    const first = !av;
    if (first) { av = createAvatar(null, null, ap); av.root.rotation.y = Math.PI; av.play('idle'); pivot.add(av.root); }
    else av.setAppearance(ap);
    fit();
    if (!first) react();
    render();
  }
  function react() {   // a quick wave when the look changes (at most once per 2.4 s)
    const now = performance.now(); if (!av || reduceMotion || now - reactAt < 2400) return;
    reactAt = now; av.play('wave', { key: now, fade: 0.15 });
    clearTimeout(reactTimer); reactTimer = setTimeout(() => { if (av) av.play('idle', { fade: 0.25 }); }, 1800);
  }
  function render() { if (av) { pivot.rotation.y = yaw; renderer.render(scene, camera); } }
  function frame(t) {
    raf = 0; if (!running) return;
    const dt = Math.min(0.05, (t - last) / 1000 || 0.016); last = t;
    if (av && visible && !document.hidden) {
      if (!dragging && !reduceMotion && t - idleSince > 1800) yaw += dt * 0.55;   // slow turn once left alone
      av.update(dt); render();
    }
    raf = requestAnimationFrame(frame);
  }
  function start() { if (running) return; running = true; last = performance.now(); raf = requestAnimationFrame(frame); }
  function stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }

  // drag to turn (vertical pans stay with the page: touch-action: pan-y), arrow keys when focused
  const down = (e) => { dragging = true; lastX = e.clientX; try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* old browsers */ } };
  const move = (e) => { if (!dragging) return; yaw += (e.clientX - lastX) * 0.012; lastX = e.clientX; idleSince = performance.now(); render(); };
  const up = () => { dragging = false; idleSince = performance.now(); };
  const keys = (e) => { if (e.key === 'ArrowLeft') yaw -= 0.25; else if (e.key === 'ArrowRight') yaw += 0.25; else return; e.preventDefault(); idleSince = performance.now(); render(); };
  canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up); canvas.addEventListener('keydown', keys);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { fit(); render(); }) : null; if (ro) ro.observe(canvas);
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((es) => { visible = es[es.length - 1].isIntersecting; }) : null; if (io) io.observe(canvas);

  return {
    setAppearance, start, stop, resize() { fit(); render(); },
    get avatar() { return av; }, get yaw() { return yaw; }, set yaw(v) { yaw = v; render(); },
    dispose() {
      stop(); clearTimeout(reactTimer); if (ro) ro.disconnect(); if (io) io.disconnect();
      canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointercancel', up); canvas.removeEventListener('keydown', keys);
      if (av) { av.dispose(); av = null; }
      renderer.dispose(); try { renderer.forceContextLoss(); } catch (_) { /* already gone */ }
    },
  };
}
