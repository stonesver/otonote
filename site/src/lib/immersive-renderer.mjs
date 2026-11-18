import {readThemePalette, observeTheme} from './theme-palette.mjs';
import * as THREE from 'three';
import { Skeleton, RegionAttachment, MeshAttachment, AtlasAttachmentLoader, SkeletonJson, SkeletonBinary, SkeletonMesh, TextureAtlas, ThreeJsTexture } from '@esotericsoftware/spine-threejs';
import { createSpinePoseSampler } from './immersive-pose.mjs';
import { composeSpineDrawOrder, pointInTriangle } from './immersive-composition.mjs';
import { createImmersivePlayback, isImmersiveTap } from './immersive-playback.mjs';
import { EXPORT_SIZE, recordCanvas, pngRenderSize, pngOutputSize, downsamplePng } from './immersive-export.mjs';

export async function createImmersiveScene(host, resources, { signal, onTime = () => {}, onError = () => {}, onCharacter = () => {}, profile = null } = {}) {
  signal?.throwIfAborted();
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.domElement.setAttribute('aria-label', host.closest('[data-immersive]')?.getAttribute('aria-label') ?? 'Animated scene');
  const scene = new THREE.Scene(), root = new THREE.Group();
  let themePalette = readThemePalette(host);
  scene.background = new THREE.Color(themePalette.inverseSurface);
  root.scale.z = -1; scene.add(root);
  const camera = new THREE.PerspectiveCamera(30, 16 / 9, .01, 100);
  const textures = [], materials = [], geometries = [], skeletons = [], layers = [], samplers = [], nodes = new Map();
  let frame = 0, time = 0, last = 0, paused = true, visible = true, disposed = false, exporting = false;
  let layer = 'all', duration = 0, zoom = 1, initialZoom = 1, recordingAbort, resizeObserver, intersectionObserver, disconnectTheme, data, playback, runtimeCharacters;
  const pan = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  const events = new AbortController();
  const read = async (file, json = true) => {
    signal?.throwIfAborted();
    const blob = resources.blobs.get(file);
    if (!blob) throw new Error(`asset-unavailable: ${file}`);
    return json === 'binary' ? new Uint8Array(await blob.arrayBuffer()) : json ? JSON.parse(await blob.text()) : blob.text();
  };
  const loadTexture = async name => {
    signal?.throwIfAborted();
    const blob = resources.blobs.get(name);
    if (!blob) throw new Error(`asset-unavailable: ${name}`);
    const url = URL.createObjectURL(blob);
    try {
      const texture = await new THREE.TextureLoader().loadAsync(url);
      textures.push(texture); signal?.throwIfAborted(); return texture;
    } finally { URL.revokeObjectURL(url); }
  };
  function updateCamera() {
    if (!profile) { camera.position.set(pan.x, pan.y, 0); return; }
    const { start, end, target, duration: seconds } = profile.camera;
    const progress = seconds > 0 ? Math.min(time / seconds, 1) : 1;
    const eased = 1 - (1 - progress) ** 3; // client zoomOutEase = OutCubic (9)
    camera.position.fromArray(start).lerp(new THREE.Vector3(...end), eased);
    camera.position.x += pan.x; camera.position.y += pan.y;
    camera.lookAt(target[0] + pan.x, target[1] + pan.y, target[2]);
  }
  function flushPoses() { for (const sample of samplers) sample(); }
  function notifyTime() { onTime(time, { playing: playback.playing, characters: playback.characters }); }
  function pose(value) {
    playback.seek(value); time = playback.time; flushPoses(); updateCamera();
  }
  function render() { renderer.render(scene, camera); }
  function fitCamera(width, height) {
    camera.aspect = width / height;
    // Preserve the whole cast on portrait screens; zoom remains relative to the fitted view.
    const tangent = Math.tan(THREE.MathUtils.degToRad((profile?.camera.fov ?? data.calibration.verticalFov ?? 30) / 2));
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(tangent * Math.max(1, (16 / 9) / camera.aspect) / zoom));
    camera.updateProjectionMatrix();
  }
  function resize() {
    if (disposed || exporting || !host.clientWidth || !host.clientHeight) return;
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight, false);
    fitCamera(host.clientWidth, host.clientHeight); render();
  }
  function loop(now) {
    frame = 0;
    if (disposed || !visible || document.hidden || exporting || paused) return;
    playback.advance(Math.min((now - last) / 1000, .05)); time = playback.time; last = now;
    flushPoses(); updateCamera(); render(); notifyTime();
    if (playback.playing) frame = requestAnimationFrame(loop);
  }
  function schedule() {
    cancelAnimationFrame(frame); frame = 0; last = performance.now();
    if (!disposed && !paused && playback?.playing && visible && !document.hidden && !exporting) frame = requestAnimationFrame(loop);
  }
  function dispose() {
    if (disposed) return;
    disposed = true; recordingAbort?.abort(); cancelAnimationFrame(frame);
    events.abort(); resizeObserver?.disconnect(); intersectionObserver?.disconnect(); disconnectTheme?.();
    skeletons.forEach(mesh => mesh.dispose()); geometries.forEach(g => g.dispose());
    materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose());
    renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
  }
  try {
    data = resources.data;
    initialZoom = profile ? 1 : data.calibration.initialZoom ?? 1; zoom = initialZoom;
    // Downloads are complete. Decode locally in order so partial GPU setup is always disposable.
    const textureMap = new Map(), atlasMap = new Map(), materialMap = new Map(), spineTextures = new Map();
    function spinePage(id) {
      if (!spineTextures.has(id)) {
        const pageTexture = new ThreeJsTexture(textureMap.get(id).image, false);
        textures.push(pageTexture.texture); spineTextures.set(id, pageTexture);
      }
      return spineTextures.get(id);
    }
    for (const [id, file] of Object.entries(data.textures ?? { background: 'background.webp', characters: 'characters.webp' })) {
      const texture = await loadTexture(file); texture.colorSpace = THREE.LinearSRGBColorSpace;
      texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy()); textureMap.set(id, texture);
    }
    for (const [id, entry] of Object.entries(data.atlases ?? { default: { file: 'characters.atlas', pages: { 'characters.webp': 'characters' } } })) {
      const atlas = new TextureAtlas(await read(entry.file, false));
      for (const page of atlas.pages) {
        const textureId = entry.pages[page.name];
        if (!textureMap.has(textureId)) throw new Error(`atlas-page-unavailable: ${page.name}`);
        page.setTexture(spinePage(textureId));
      }
      atlasMap.set(id, atlas);
    }
    for (const [id, entry] of Object.entries(data.materials ?? { default: { texture: 'background' } })) {
      const color = entry.color ?? { r: 1, g: 1, b: 1, a: 1 };
      const material = new THREE.MeshBasicMaterial({ map: textureMap.get(entry.texture) ?? null,
        color: new THREE.Color(color.r, color.g, color.b), opacity: color.a,
        side: THREE.DoubleSide, transparent: true, alphaTest: .05 });
      materials.push(material); materialMap.set(id, material);
    }
    for (const node of data.nodes) {
      const group = new THREE.Group(); group.name = node.name; group.userData.source = node;
      group.position.fromArray(node.position); group.quaternion.fromArray(node.rotation); group.scale.fromArray(node.scale);
      group.visible = node.active && !data.hide.includes(node.gameObjectId);
      if (node.backgroundRoot || node.id === profile?.background.node || node.name === 'home_001_mygo_02_lobby_0102') {
        if (profile) {
          group.position.fromArray(profile.background.position);
          group.rotation.set(...profile.background.rotation.map(THREE.MathUtils.degToRad), 'YXZ');
          group.scale.fromArray(profile.background.scale);
        } else if (data.calibration.backgroundPosition) group.position.fromArray(data.calibration.backgroundPosition);
        group.userData.backgroundRoot = true;
      }
      if (node.mesh && data.meshes[node.mesh]) {
        const mesh = data.meshes[node.mesh], geometry = new THREE.BufferGeometry();
        if (!mesh.positions?.length || !mesh.uv?.length || !mesh.indices?.length) {
          geometry.dispose(); nodes.set(node.id, group); continue;
        }
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(mesh.positions.flat(), 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(mesh.uv.flat(), 2)); geometry.setIndex(mesh.indices);
        geometries.push(geometry);
        const assigned = (node.materials ?? ['default']).map(id => materialMap.get(id));
        if (assigned.some(m => !m)) throw new Error(`material-unavailable: ${node.name}`);
        if (assigned.length > 1) for (const g of mesh.groups ?? []) geometry.addGroup(g.start, g.count, g.materialIndex);
        const view = new THREE.Mesh(geometry, assigned.length === 1 ? assigned[0] : assigned);
        view.visible = node.enabled; view.renderOrder = node.order ?? 0; group.add(view);
      }
      if (node.spine) {
        const binary = node.spineFormat === 'binary';
        const Parser = binary ? SkeletonBinary : SkeletonJson;
        const parser = new Parser(new AtlasAttachmentLoader(atlasMap.get(node.atlas ?? 'default'))); parser.scale = node.spineScale;
        const skeleton = parser.readSkeletonData(await read(`${node.spine}.${binary ? 'skel' : 'json'}`, binary ? 'binary' : true));
        const mesh = new SkeletonMesh({ skeletonData: skeleton, materialFactory: () => new THREE.MeshBasicMaterial({
          ...SkeletonMesh.DEFAULT_MATERIAL_PARAMETERS, depthWrite: false, depthTest: false, alphaTest: .01
        }) });
        mesh.zOffset = 0; if (node.animation) mesh.state.setAnimation(0, node.animation, false); mesh.update(0);
        mesh.renderOrder = 100 + node.order; mesh.traverse(o => { o.renderOrder = 100 + node.order; });
        group.add(mesh); skeletons.push(mesh);
        const ownership = profile?.partitions?.[node.id];
        const animation = mesh.state.tracks[0]?.animation;
        mesh.state.clearTracks();
        if (ownership && animation) {
          mesh.userData.slotOwners = ownership.slots;
          const members = new Map([...new Set(ownership.slots.filter(id => id !== null))]
            .map(id => [id, new Skeleton(skeleton)]));
          const times = new Map([[null, 0], ...[...members.keys()].map(id => [id, 0])]);
          for (const id of times.keys()) layers.push({ id: id === null ? node.id : `${node.id}@${id}`,
            duration: animation.duration, apply(value) { times.set(id, value); } });
          const poses = new Map([[null, mesh.skeleton], ...members].map(([id, skeleton]) =>
            [id, createSpinePoseSampler(skeleton, animation)]));
          samplers.push(() => {
            for (const [id, sample] of poses) sample(times.get(id));
            mesh.skeleton.drawOrder = composeSpineDrawOrder(mesh.skeleton, members, ownership.slots);
            mesh.updateGeometry(); mesh.traverse(object => { object.renderOrder = 100 + node.order; });
          });
        } else {
          const character = profile?.characters.find(character => character.nodes.includes(node.id));
          if (character) group.userData.characterId = character.id;
          const sample = createSpinePoseSampler(mesh.skeleton, animation);
          layers.push({ id: node.id, duration: animation?.duration ?? 0, apply(value) {
            sample(value); mesh.updateGeometry(); mesh.traverse(object => { object.renderOrder = 100 + node.order; });
          } });
        }
        mesh.userData.spineMesh = true;
      }
      nodes.set(node.id, group);
    }
    for (const node of data.nodes) (nodes.get(node.parent) ?? root).add(nodes.get(node.id));
    runtimeCharacters = profile?.characters.map(character => ({ ...character,
      nodes: character.nodes.map(id => profile.partitions?.[id] ? `${id}@${character.id}` : id) }));
    playback = createImmersivePlayback(layers, runtimeCharacters); duration = playback.duration;
    if (!(duration > 0)) throw Error('scene-animation-unavailable');
    signal?.throwIfAborted(); host.appendChild(renderer.domElement); pose(0); resize();
    resizeObserver = new ResizeObserver(resize); resizeObserver.observe(host);
    disconnectTheme = observeTheme(host, () => {
      themePalette = readThemePalette(host);
      if (layer !== 'characters') scene.background = new THREE.Color(themePalette.inverseSurface);
      if (!exporting) render();
    });
    intersectionObserver = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; schedule(); });
    intersectionObserver.observe(host);
    document.addEventListener('visibilitychange', () => { if (document.hidden) recordingAbort?.abort(); schedule(); }, { signal: events.signal });
    renderer.domElement.addEventListener('webglcontextlost', event => { event.preventDefault(); recordingAbort?.abort(); paused = true; schedule(); onError(); }, { signal: events.signal });
    // Raycast the rendered geometry, including the foreground: a table is not a character.
    function pickCharacter(event) {
      if (layer === 'background') return;
      const bounds = host.getBoundingClientRect();
      scene.updateMatrixWorld(true);
      for (const mesh of skeletons) mesh.traverse(child => {
        if (child.geometry) { child.geometry.computeBoundingBox(); child.geometry.computeBoundingSphere(); }
      });
      raycaster.setFromCamera(new THREE.Vector2((event.clientX - bounds.left) / bounds.width * 2 - 1,
        -(event.clientY - bounds.top) / bounds.height * 2 + 1), camera);
      const hits = raycaster.intersectObjects(skeletons, true)
        .sort((a, b) => b.object.renderOrder - a.object.renderOrder || a.distance - b.distance);
      for (const hit of hits) {
        let object = hit.object, id, shown = true, spine;
        while (object) {
          shown &&= object.visible; id ??= object.userData.characterId;
          if (object.userData.spineMesh) spine = object;
          object = object.parent;
        }
        if (spine?.userData.slotOwners) {
          const point = spine.worldToLocal(hit.point.clone());
          for (const slot of [...spine.skeleton.drawOrder].reverse()) {
            const attachment = slot.getAttachment();
            if (!attachment || slot.color.a < .01 || attachment.color?.a < .01) continue;
            let vertices, triangles;
            if (attachment instanceof RegionAttachment) {
              vertices = new Float32Array(8); triangles = SkeletonMesh.QUAD_TRIANGLES;
              attachment.computeWorldVertices(slot, vertices, 0, 2);
            } else if (attachment instanceof MeshAttachment) {
              vertices = new Float32Array(attachment.worldVerticesLength); triangles = attachment.triangles;
              attachment.computeWorldVertices(slot, 0, vertices.length, vertices, 0, 2);
            } else continue;
            let inside = false;
            for (let i = 0; i < triangles.length; i += 3) {
              const [a, b, c] = triangles.slice(i, i + 3).map(index => index * 2);
              if (pointInTriangle(point.x, point.y, vertices[a], vertices[a+1], vertices[b], vertices[b+1], vertices[c], vertices[c+1])) { inside = true; break; }
            }
            if (inside) { id = spine.userData.slotOwners[slot.data.index]; break; }
          }
        }
        if (!shown) continue;
        if (id !== undefined && id !== null) onCharacter(id);
        return;
      }
    }
    let drag;
    host.addEventListener('pointerdown', event => {
      if (exporting || event.button !== 0 || !event.isPrimary) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, cx: pan.x, cy: pan.y, moved: false };
      host.setPointerCapture(event.pointerId);
    }, { signal: events.signal });
    host.addEventListener('pointermove', event => {
      if (!drag || drag.id !== event.pointerId || exporting) return;
      drag.moved ||= !isImmersiveTap(drag, { x: event.clientX, y: event.clientY });
      if (!drag.moved) return;
      pan.x = THREE.MathUtils.clamp(drag.cx - (event.clientX - drag.x) / host.clientHeight, -.8, .8);
      pan.y = THREE.MathUtils.clamp(drag.cy + (event.clientY - drag.y) / host.clientHeight, -.8, .8);
      updateCamera(); render();
    }, { signal: events.signal });
    host.addEventListener('pointerup', event => {
      if (drag?.id !== event.pointerId) return;
      const tap = !drag.moved && isImmersiveTap(drag, { x: event.clientX, y: event.clientY });
      drag = null;
      if (!exporting && tap) pickCharacter(event);
    }, { signal: events.signal });
    for (const name of ['pointercancel', 'lostpointercapture']) host.addEventListener(name, () => { drag = null; }, { signal: events.signal });
  } catch (error) { dispose(); throw error; }

  async function exportWith(operation, size = EXPORT_SIZE) {
    if (disposed || exporting) throw new Error('viewer-unavailable');
    exporting = true; schedule(); const savedPlayback = playback.snapshot();
    try {
      renderer.setPixelRatio(1); renderer.setSize(size.width, size.height, false);
      fitCamera(size.width, size.height);
      return await operation();
    }
    finally { exporting = false; if (!disposed) { playback.restore(savedPlayback); time = playback.time; flushPoses(); updateCamera(); resize(); schedule(); notifyTime(); } }
  }
  function pngLimit() {
    const gl = renderer.getContext();
    return Math.min(renderer.capabilities.maxTextureSize, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), ...gl.getParameter(gl.MAX_VIEWPORT_DIMS));
  }
  return {
    duration,
    setPaused(value) { paused = value; schedule(); notifyTime(); },
    get finished() { return !playback.playing; },
    get characters() { return profile?.characters ?? []; },
    seek(value) { if (exporting) return; pose(value); render(); notifyTime(); schedule(); },
    replay() { if (exporting) return; pose(0); paused = false; render(); notifyTime(); schedule(); },
    replayCharacter(id) {
      if (exporting || layer === 'background' || !playback.replay(id)) return false;
      paused = false; flushPoses(); render(); notifyTime(); schedule(); return true;
    },
    setLayer(value) {
      layer = value;
      scene.background = value === 'characters' ? null : new THREE.Color(themePalette.inverseSurface);
      for (const group of nodes.values()) {
        if (group.userData.backgroundRoot) group.visible = value !== 'characters';
        if (group.userData.source.spine) group.visible = value !== 'background';
        if (!group.userData.source.spine && group.userData.source.active) {
          const hiddenInScene = data.hide.includes(group.userData.source.gameObjectId);
          if (hiddenInScene) group.visible = value === 'background';
        }
      }
      render();
    },
    zoom(delta) { zoom = THREE.MathUtils.clamp(zoom + delta, .8, 2.4); resize(); },
    reset() { zoom = initialZoom; pan.set(0, 0); updateCamera(); resize(); },
    get pngSize() { return pngOutputSize(pngLimit()); },
    async png(progress = () => {}) {
      const limit = pngLimit();
      return exportWith(async () => {
        recordingAbort = new AbortController();
        const signal = recordingAbort.signal;
        try {
          progress(.1, 'render');
          // Let the progress UI paint before the expensive high-resolution render.
          await new Promise(resolve => setTimeout(resolve, 0)); signal.throwIfAborted();
          render();
          // Read back immediately. Keep 4K detail and avoid a second blur/FXAA pass.
          const result = downsamplePng(renderer.domElement, pngOutputSize(limit));
          progress(.65, 'encode');
          const blob = await result; signal.throwIfAborted();
          progress(.95, 'save'); return blob;
        } finally { recordingAbort = null; }
      }, pngRenderSize(limit));
    },
    async webm(progress) {
      return exportWith(async () => {
        recordingAbort = new AbortController();
        // WebM alpha playback differs by browser. Use a solid background for predictable output.
        const previousBackground = scene.background; scene.background ??= new THREE.Color(themePalette.inverseSurface);
        try { return await recordCanvas(renderer.domElement, duration, { signal: recordingAbort.signal, render(t) { pose(t); render(); }, progress }); }
        finally { scene.background = previousBackground; recordingAbort = null; }
      });
    },
    cancelExport() { recordingAbort?.abort(); },
    get layer() { return layer; },
    dispose
  };
}
