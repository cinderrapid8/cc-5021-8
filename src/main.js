import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  BONE_DEFINITIONS,
  CrowdPoseEvaluator,
  createCharacterAssets,
  createReferenceCharacter,
  getBonePositionFromMatrices
} from './character.js';
import { createCity } from './city.js';

const MAX_COUNT = 512;
const INITIAL_COUNT = 160;
const LANE_COUNT = 9;
const STATS_WINDOW = 120;
const FOG_COLOR = new THREE.Color(0x9fb4c9);
const FOG_NEAR = 34;
const FOG_FAR = 92;
const SUN_DIRECTION = new THREE.Vector3(-0.45, 0.82, 0.35).normalize();

const canvas = document.getElementById('scene');
const countRange = document.getElementById('countRange');
const countInput = document.getElementById('countInput');
const countLabel = document.getElementById('countLabel');
const addOneButton = document.getElementById('addOne');
const removeOneButton = document.getElementById('removeOne');
const playPauseButton = document.getElementById('playPause');
const resetCameraButton = document.getElementById('resetCamera');
const runCheckButton = document.getElementById('runCheck');
const checkResult = document.getElementById('checkResult');
const statsList = document.getElementById('statsList');
const characterSelect = document.getElementById('characterSelect');
const selectedInfo = document.getElementById('selectedInfo');
const boneTable = document.getElementById('boneTable');
const referenceCanvas = document.getElementById('referenceView');

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance'
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.info.autoReset = true;

if (!renderer.capabilities.isWebGL2) {
  checkResult.textContent = '当前浏览器未提供 WebGL2，实例骨骼纹理路径无法运行。';
  checkResult.className = 'check-result fail';
  throw new Error('WebGL2 is required');
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8ea9c4);
scene.fog = new THREE.Fog(FOG_COLOR, FOG_NEAR, FOG_FAR);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 180);
const defaultCameraPosition = new THREE.Vector3(20, 17, 26);
const defaultTarget = new THREE.Vector3(0, 1.0, 0);
camera.position.copy(defaultCameraPosition);

const controls = new OrbitControls(camera, canvas);
controls.target.copy(defaultTarget);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.48;
controls.minDistance = 8;
controls.maxDistance = 70;

scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x27331f, 1.7));
const sunLight = new THREE.DirectionalLight(0xfff2d0, 2.2);
sunLight.position.copy(SUN_DIRECTION).multiplyScalar(30);
scene.add(sunLight);

createCity(scene);

const assets = createCharacterAssets();
const evaluator = new CrowdPoseEvaluator(assets, MAX_COUNT);
const instanceIds = new Float32Array(MAX_COUNT);
for (let i = 0; i < MAX_COUNT; i++) instanceIds[i] = i;
assets.geometry.setAttribute('aInstanceId', new THREE.InstancedBufferAttribute(instanceIds, 1));

let activeCount = INITIAL_COUNT;
let selectedId = 0;
let playing = true;
let simTime = 0;
let poseDirty = true;
let transformDirty = true;
let referenceDirty = true;
let lastPoseUploadBytes = 0;
let lastPoseMatrices = 0;
let lastPoseUploads = 0;
let lastTransformUploadBytes = 0;
let mainDrawCalls = 0;
let mainTriangles = 0;
let referenceDrawCalls = 0;

let boneTexture = createBoneTexture(activeCount);
const crowdMaterial = createCrowdMaterial(boneTexture);
const crowdMesh = new THREE.InstancedMesh(assets.geometry, crowdMaterial, MAX_COUNT);
crowdMesh.name = 'CrowdInstancedSkinnedMesh';
crowdMesh.count = activeCount;
crowdMesh.frustumCulled = false;
crowdMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
scene.add(crowdMesh);

const instanceConfigs = createInstanceConfigs();
const instanceTimes = evaluator.times;
const instanceColors = new Float32Array(MAX_COUNT * 3);
const color = new THREE.Color();
for (let i = 0; i < MAX_COUNT; i++) {
  color.setHSL(instanceConfigs[i].hue, 0.58, 0.52);
  instanceColors[i * 3] = color.r;
  instanceColors[i * 3 + 1] = color.g;
  instanceColors[i * 3 + 2] = color.b;
}
crowdMesh.instanceColor = new THREE.InstancedBufferAttribute(instanceColors, 3);
crowdMesh.instanceColor.needsUpdate = true;

const selectedSkeleton = createSelectedSkeletonOverlay();
scene.add(selectedSkeleton.lines, selectedSkeleton.points, selectedSkeleton.ring);

const reference = createReferenceScene();
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pointerDownX = 0;
let pointerDownY = 0;

const frameIntervals = [];
const cpuTimes = [];
const renderTimes = [];
let lastFrameNow = performance.now();
let frameIndex = 0;
let autoCheckDone = false;

const tmpMatrixA = new THREE.Matrix4();
const tmpMatrixB = new THREE.Matrix4();
const tmpMatrixC = new THREE.Matrix4();
const tmpVectorA = new THREE.Vector3();
const tmpVectorB = new THREE.Vector3();
const tmpQuaternion = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();
const yAxis = new THREE.Vector3(0, 1, 0);

initializeUi();
resize();
window.addEventListener('resize', resize);
requestAnimationFrame(animate);

function createCrowdMaterial(texture) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uBoneTexture: { value: texture },
      uSunDirection: { value: SUN_DIRECTION },
      uFogColor: { value: FOG_COLOR },
      uFogNear: { value: FOG_NEAR },
      uFogFar: { value: FOG_FAR }
    },
    vertexShader: `
      uniform sampler2D uBoneTexture;

      attribute vec4 skinIndex;
      attribute vec4 skinWeight;
      attribute float aInstanceId;
      attribute float aPart;

      varying vec3 vWorldPosition;
      varying vec3 vNormal;
      varying vec3 vInstanceColor;
      varying float vPart;

      mat4 getBoneMatrix(int boneIndex) {
        int x = boneIndex * 4;
        int y = int(aInstanceId + 0.5);
        vec4 column0 = texelFetch(uBoneTexture, ivec2(x, y), 0);
        vec4 column1 = texelFetch(uBoneTexture, ivec2(x + 1, y), 0);
        vec4 column2 = texelFetch(uBoneTexture, ivec2(x + 2, y), 0);
        vec4 column3 = texelFetch(uBoneTexture, ivec2(x + 3, y), 0);
        return mat4(column0, column1, column2, column3);
      }

      void main() {
        vec4 skinnedPosition = vec4(0.0);
        vec3 skinnedNormal = vec3(0.0);

        for (int i = 0; i < 4; i++) {
          float weight = skinWeight[i];
          if (weight > 0.0) {
            int boneIndex = int(skinIndex[i] + 0.5);
            mat4 boneMatrix = getBoneMatrix(boneIndex);
            skinnedPosition += weight * (boneMatrix * vec4(position, 1.0));
            skinnedNormal += weight * (mat3(boneMatrix) * normal);
          }
        }

        vec4 worldPosition = modelMatrix * instanceMatrix * skinnedPosition;
        vWorldPosition = worldPosition.xyz;
        vNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * skinnedNormal);
        vInstanceColor = instanceColor;
        vPart = aPart;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uSunDirection;
      uniform vec3 uFogColor;
      uniform float uFogNear;
      uniform float uFogFar;

      varying vec3 vWorldPosition;
      varying vec3 vNormal;
      varying vec3 vInstanceColor;
      varying float vPart;

      void main() {
        vec3 skin = mix(vec3(0.78, 0.50, 0.34), vec3(0.96, 0.76, 0.58), fract(vInstanceColor.r * 7.13));
        vec3 shirt = vInstanceColor;
        vec3 pants = mix(vec3(0.08, 0.12, 0.20), vInstanceColor * 0.45 + vec3(0.05, 0.07, 0.10), 0.55);
        vec3 shoes = vec3(0.055, 0.06, 0.07);
        vec3 hair = mix(vec3(0.08, 0.045, 0.025), vec3(0.28, 0.16, 0.07), fract(vInstanceColor.g * 5.71));

        vec3 base = skin;
        if (vPart > 0.5 && vPart < 1.5) base = shirt;
        else if (vPart > 1.5 && vPart < 2.5) base = pants;
        else if (vPart > 2.5 && vPart < 3.5) base = shoes;
        else if (vPart > 3.5) base = hair;

        vec3 normal = normalize(vNormal);
        float diffuse = max(dot(normal, uSunDirection), 0.0);
        float hemisphere = 0.42 + 0.24 * max(normal.y, 0.0);
        float rim = pow(1.0 - max(dot(normal, normalize(cameraPosition - vWorldPosition)), 0.0), 2.0) * 0.12;
        vec3 color = base * (hemisphere + diffuse * 0.72) + rim;

        float fogFactor = smoothstep(uFogNear, uFogFar, length(vWorldPosition - cameraPosition));
        color = mix(color, uFogColor, fogFactor);
        gl_FragColor = vec4(color, 1.0);
        #include <colorspace_fragment>
      }
    `
  });
}

function createBoneTexture(count) {
  const texture = new THREE.DataTexture(
    evaluator.skinMatrices.subarray(0, count * assets.boneCount * 16),
    assets.boneCount * 4,
    count,
    THREE.RGBAFormat,
    THREE.FloatType
  );
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

function replaceBoneTexture(count) {
  const oldTexture = boneTexture;
  boneTexture = createBoneTexture(count);
  crowdMaterial.uniforms.uBoneTexture.value = boneTexture;
  oldTexture.dispose();
}

function createSelectedSkeletonOverlay() {
  const boneCount = assets.boneCount;
  const linePositions = new Float32Array((boneCount - 1) * 2 * 3);
  const pointPositions = new Float32Array(boneCount * 3);

  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute('position', new THREE.BufferAttribute(linePositions, 3).setUsage(THREE.DynamicDrawUsage));
  const lines = new THREE.LineSegments(
    lineGeometry,
    new THREE.LineBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.95, depthTest: false })
  );
  lines.name = 'SelectedSkeletonLines';
  lines.renderOrder = 30;
  lines.frustumCulled = false;

  const pointGeometry = new THREE.BufferGeometry();
  pointGeometry.setAttribute('position', new THREE.BufferAttribute(pointPositions, 3).setUsage(THREE.DynamicDrawUsage));
  const points = new THREE.Points(
    pointGeometry,
    new THREE.PointsMaterial({ color: 0x7dd3fc, size: 0.075, sizeAttenuation: true, depthTest: false })
  );
  points.name = 'SelectedSkeletonJoints';
  points.renderOrder = 31;
  points.frustumCulled = false;

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.34, 0.43, 32),
    new THREE.MeshBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthTest: false })
  );
  ring.name = 'SelectedCharacterRing';
  ring.rotation.x = -Math.PI / 2;
  ring.renderOrder = 29;

  return {
    lines,
    points,
    ring,
    linePositions,
    pointPositions,
    worldBonePositions: new Float32Array(boneCount * 3)
  };
}

function createReferenceScene() {
  const refRenderer = new THREE.WebGLRenderer({ canvas: referenceCanvas, antialias: true, alpha: true });
  refRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  refRenderer.outputColorSpace = THREE.SRGBColorSpace;
  refRenderer.info.autoReset = true;

  const refScene = new THREE.Scene();
  refScene.background = new THREE.Color(0x0b1524);
  const refCamera = new THREE.PerspectiveCamera(38, 1, 0.05, 30);
  refCamera.position.set(2.35, 1.55, 3.0);

  const refControls = new OrbitControls(refCamera, referenceCanvas);
  refControls.target.set(0, 0.95, 0);
  refControls.enableDamping = true;
  refControls.enablePan = false;
  refControls.minDistance = 1.5;
  refControls.maxDistance = 6;

  refScene.add(new THREE.HemisphereLight(0xd8ecff, 0x1f2937, 2.0));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(3, 4, 2);
  refScene.add(key);

  const grid = new THREE.GridHelper(2.6, 13, 0x33506f, 0x1d2b3f);
  grid.position.y = 0;
  refScene.add(grid);

  const rig = createReferenceCharacter(assets);
  refScene.add(rig.mesh);

  const skeletonHelper = new THREE.SkeletonHelper(rig.mesh);
  skeletonHelper.material.depthTest = false;
  skeletonHelper.renderOrder = 10;
  refScene.add(skeletonHelper);

  return { renderer: refRenderer, scene: refScene, camera: refCamera, controls: refControls, rig, skeletonHelper };
}

function createInstanceConfigs() {
  const configs = [];
  for (let id = 0; id < MAX_COUNT; id++) {
    const lane = id % LANE_COUNT;
    const direction = lane % 2 === 0 ? 1 : -1;
    configs.push({
      id,
      lane,
      direction,
      orbitPhase: hash01(id, 1),
      orbitSpeed: direction * (0.045 + hash01(id, 2) * 0.035),
      radialOffset: (hash01(id, 3) - 0.5) * 0.55,
      animPhase: hash01(id, 4),
      animSpeed: 0.82 + hash01(id, 5) * 0.42,
      scale: 0.90 + hash01(id, 6) * 0.16,
      hue: (hash01(id, 7) * 0.72 + 0.02) % 1
    });
  }
  return configs;
}

function initializeUi() {
  countRange.value = String(activeCount);
  countInput.value = String(activeCount);
  countLabel.textContent = String(activeCount);

  countRange.addEventListener('input', () => setActiveCount(Number(countRange.value)));
  countInput.addEventListener('change', () => setActiveCount(Number(countInput.value)));
  addOneButton.addEventListener('click', () => setActiveCount(activeCount + 1));
  removeOneButton.addEventListener('click', () => setActiveCount(activeCount - 1));

  document.querySelectorAll('[data-count]').forEach((button) => {
    button.addEventListener('click', () => setActiveCount(Number(button.dataset.count)));
  });

  playPauseButton.addEventListener('click', () => {
    playing = !playing;
    playPauseButton.textContent = playing ? '暂停' : '播放';
  });

  resetCameraButton.addEventListener('click', () => {
    camera.position.copy(defaultCameraPosition);
    controls.target.copy(defaultTarget);
    controls.update();
  });

  runCheckButton.addEventListener('click', runIntegrityCheck);
  characterSelect.addEventListener('change', () => selectCharacter(Number(characterSelect.value)));

  canvas.addEventListener('pointerdown', (event) => {
    pointerDownX = event.clientX;
    pointerDownY = event.clientY;
  });

  canvas.addEventListener('pointerup', (event) => {
    const moved = Math.hypot(event.clientX - pointerDownX, event.clientY - pointerDownY);
    if (moved > 5) return;
    pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(crowdMesh, false);
    if (hits.length > 0 && hits[0].instanceId !== undefined) {
      selectCharacter(hits[0].instanceId);
    }
  });

  refreshCharacterSelect();
  updateSelectedInspector(true);
}

function setActiveCount(nextCount) {
  const clamped = Math.max(1, Math.min(MAX_COUNT, Math.round(nextCount || 1)));
  if (clamped === activeCount) {
    countRange.value = String(activeCount);
    countInput.value = String(activeCount);
    countLabel.textContent = String(activeCount);
    return;
  }

  activeCount = clamped;
  crowdMesh.count = activeCount;
  replaceBoneTexture(activeCount);
  if (selectedId >= activeCount) selectedId = activeCount - 1;
  poseDirty = true;
  transformDirty = true;
  referenceDirty = true;

  countRange.value = String(activeCount);
  countInput.value = String(activeCount);
  countLabel.textContent = String(activeCount);
  refreshCharacterSelect();
}

function refreshCharacterSelect() {
  characterSelect.innerHTML = '';
  for (let i = 0; i < activeCount; i++) {
    const option = document.createElement('option');
    option.value = String(i);
    option.textContent = `#${String(i).padStart(3, '0')}`;
    characterSelect.appendChild(option);
  }
  characterSelect.value = String(selectedId);
}

function selectCharacter(id) {
  if (id < 0 || id >= activeCount || id === selectedId) return;
  selectedId = id;
  characterSelect.value = String(selectedId);
  referenceDirty = true;
  updateSelectedInspector(true);
}

function animate(now) {
  requestAnimationFrame(animate);

  const frameInterval = now - lastFrameNow;
  lastFrameNow = now;
  pushSample(frameIntervals, frameInterval);

  const cpuStart = performance.now();
  const dt = Math.min(0.05, Math.max(0, frameInterval / 1000));
  if (playing) {
    simTime += dt;
    poseDirty = true;
    transformDirty = true;
    referenceDirty = true;
  }

  updateCrowd();
  updateSelectedSkeletonOverlay();
  if (referenceDirty) updateReferencePose();
  controls.update();
  reference.controls.update();
  const cpuMs = performance.now() - cpuStart;
  pushSample(cpuTimes, cpuMs);

  const renderStart = performance.now();
  renderer.render(scene, camera);
  mainDrawCalls = renderer.info.render.calls;
  mainTriangles = renderer.info.render.triangles;

  reference.renderer.render(reference.scene, reference.camera);
  referenceDrawCalls = reference.renderer.info.render.calls;
  const renderMs = performance.now() - renderStart;
  pushSample(renderTimes, renderMs);

  if (frameIndex % 6 === 0) updateSelectedInspector(false);
  if (frameIndex % 10 === 0) updateStats();

  if (!autoCheckDone && frameIndex > 2) {
    autoCheckDone = true;
    runIntegrityCheck();
  }

  frameIndex++;
}

function updateCrowd() {
  if (transformDirty) {
    updateInstanceTransforms();
    crowdMesh.instanceMatrix.addUpdateRange(0, activeCount * 16);
    crowdMesh.instanceMatrix.needsUpdate = true;
    lastTransformUploadBytes = activeCount * 16 * 4;
    transformDirty = false;
  } else {
    lastTransformUploadBytes = 0;
  }

  if (poseDirty) {
    for (let i = 0; i < activeCount; i++) {
      instanceTimes[i] = getAnimationTime(instanceConfigs[i]);
    }
    evaluator.evaluate(instanceTimes, activeCount);
    boneTexture.needsUpdate = true;
    lastPoseUploads = 1;
    lastPoseMatrices = activeCount * assets.boneCount;
    lastPoseUploadBytes = lastPoseMatrices * 16 * 4;
    poseDirty = false;
  } else {
    lastPoseUploads = 0;
    lastPoseMatrices = 0;
    lastPoseUploadBytes = 0;
  }
}

function updateInstanceTransforms() {
  for (let i = 0; i < activeCount; i++) {
    const config = instanceConfigs[i];
    const lane = config.lane;
    const radiusX = 9.2 + lane * 1.45 + config.radialOffset;
    const radiusZ = 7.2 + lane * 1.18 + config.radialOffset * 0.7;
    const angle = config.orbitPhase * Math.PI * 2 + simTime * config.orbitSpeed;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const direction = Math.sign(config.orbitSpeed);
    const tangentX = -radiusX * sin * direction;
    const tangentZ = radiusZ * cos * direction;
    const heading = Math.atan2(tangentX, tangentZ);

    tmpVectorA.set(radiusX * cos, 0, radiusZ * sin);
    tmpQuaternion.setFromAxisAngle(yAxis, heading);
    tmpScale.setScalar(config.scale);
    tmpMatrixA.compose(tmpVectorA, tmpQuaternion, tmpScale);
    crowdMesh.setMatrixAt(i, tmpMatrixA);
  }
}

function updateSelectedSkeletonOverlay() {
  const worldPositions = selectedSkeleton.worldBonePositions;
  tmpMatrixA.fromArray(crowdMesh.instanceMatrix.array, selectedId * 16);

  for (let bone = 0; bone < assets.boneCount; bone++) {
    tmpMatrixB.fromArray(evaluator.modelBoneMatrices, (selectedId * assets.boneCount + bone) * 16);
    tmpMatrixC.multiplyMatrices(tmpMatrixA, tmpMatrixB);
    worldPositions[bone * 3] = tmpMatrixC.elements[12];
    worldPositions[bone * 3 + 1] = tmpMatrixC.elements[13];
    worldPositions[bone * 3 + 2] = tmpMatrixC.elements[14];
  }

  let lineOffset = 0;
  for (let bone = 1; bone < assets.boneCount; bone++) {
    const parent = BONE_DEFINITIONS[bone].parent;
    for (const index of [parent, bone]) {
      selectedSkeleton.linePositions[lineOffset] = worldPositions[index * 3];
      selectedSkeleton.linePositions[lineOffset + 1] = worldPositions[index * 3 + 1];
      selectedSkeleton.linePositions[lineOffset + 2] = worldPositions[index * 3 + 2];
      lineOffset += 3;
    }
  }

  selectedSkeleton.pointPositions.set(worldPositions);
  selectedSkeleton.lines.geometry.attributes.position.needsUpdate = true;
  selectedSkeleton.points.geometry.attributes.position.needsUpdate = true;

  const instanceArray = crowdMesh.instanceMatrix.array;
  selectedSkeleton.ring.position.set(
    instanceArray[selectedId * 16 + 12],
    0.035,
    instanceArray[selectedId * 16 + 14]
  );
}

function updateReferencePose() {
  const time = getAnimationTime(instanceConfigs[selectedId]);
  reference.rig.mixer.setTime(time);
  reference.controls.update();
  referenceDirty = false;
}

function updateSelectedInspector(force) {
  if (!force && selectedId >= activeCount) return;
  const config = instanceConfigs[selectedId];
  const time = getAnimationTime(config);
  const normalized = time / assets.clip.duration;
  const heading = getHeadingDegrees(config);

  selectedInfo.innerHTML = `
    <dt>角色 ID</dt><dd>#${selectedId}</dd>
    <dt>动画时间</dt><dd>${time.toFixed(3)} s / ${assets.clip.duration.toFixed(1)} s</dd>
    <dt>归一化相位</dt><dd>${normalized.toFixed(3)}</dd>
    <dt>动画速度</dt><dd>${config.animSpeed.toFixed(2)}×</dd>
    <dt>路径 / 朝向</dt><dd>lane ${config.lane} / ${heading.toFixed(1)}°</dd>
    <dt>批处理行</dt><dd>bone texture row ${selectedId}</dd>
  `;

  let rows = '';
  for (let bone = 0; bone < assets.boneCount; bone++) {
    getBonePositionFromMatrices(evaluator.modelBoneMatrices, selectedId, bone, assets.boneCount, tmpVectorA);
    rows += `<tr><td>${BONE_DEFINITIONS[bone].name}</td><td>${tmpVectorA.x.toFixed(3)}, ${tmpVectorA.y.toFixed(3)}, ${tmpVectorA.z.toFixed(3)}</td></tr>`;
  }
  boneTable.innerHTML = rows;
}

function updateStats() {
  const intervalAvg = average(frameIntervals);
  const intervalP95 = percentile(frameIntervals, 0.95);
  const cpuAvg = average(cpuTimes);
  const cpuP95 = percentile(cpuTimes, 0.95);
  const renderAvg = average(renderTimes);
  const renderP95 = percentile(renderTimes, 0.95);
  const fps = intervalAvg > 0 ? 1000 / intervalAvg : 0;
  const hardware = getHardwareInfo();

  statsList.innerHTML = `
    <dt>GPU</dt><dd title="${escapeHtml(hardware.gpu)}">${escapeHtml(hardware.gpu)}</dd>
    <dt>CPU / DPR</dt><dd>${hardware.cores} threads / ${hardware.dpr.toFixed(2)}</dd>
    <dt>角色数量</dt><dd>${activeCount} / ${MAX_COUNT}</dd>
    <dt>帧间隔</dt><dd>${intervalAvg.toFixed(2)} ms avg, ${intervalP95.toFixed(2)} ms p95</dd>
    <dt>派生 FPS</dt><dd>${fps.toFixed(1)}（由实测间隔计算）</dd>
    <dt>CPU 更新</dt><dd>${cpuAvg.toFixed(2)} ms avg, ${cpuP95.toFixed(2)} ms p95</dd>
    <dt>渲染提交</dt><dd>${renderAvg.toFixed(2)} ms avg, ${renderP95.toFixed(2)} ms p95</dd>
    <dt>主场景 draw calls</dt><dd>${mainDrawCalls}</dd>
    <dt>人群绘制</dt><dd>1 instanced draw / ${mainTriangles} tris total</dd>
    <dt>姿态上传</dt><dd>${lastPoseUploads} texture, ${lastPoseMatrices} matrices, ${formatBytes(lastPoseUploadBytes)}</dd>
    <dt>实例矩阵上传</dt><dd>${formatBytes(lastTransformUploadBytes)}</dd>
    <dt>参考视图 draw calls</dt><dd>${referenceDrawCalls}</dd>
  `;
}

function runIntegrityCheck() {
  if (poseDirty) updateCrowd();

  const sampleIds = [...new Set([
    0,
    Math.floor((activeCount - 1) / 3),
    Math.floor((activeCount - 1) * 2 / 3),
    activeCount - 1,
    selectedId
  ])].filter((id) => id >= 0 && id < activeCount);

  let maxBoneError = 0;
  let maxIndexError = 0;
  let maxReferenceSkinError = 0;
  let maxInstanceIdError = 0;
  const signatures = new Set();
  const instanceIdAttribute = crowdMesh.geometry.getAttribute('aInstanceId');
  const referencePosition = new THREE.Vector3();
  const batchPosition = new THREE.Vector3();
  const expected = new THREE.Matrix4();
  const model = new THREE.Matrix4();
  const inverseBind = new THREE.Matrix4();

  for (const id of sampleIds) {
    maxInstanceIdError = Math.max(maxInstanceIdError, Math.abs(instanceIdAttribute.getX(id) - id));
    const time = getAnimationTime(instanceConfigs[id]);
    reference.rig.mixer.setTime(time);
    reference.rig.mesh.updateMatrixWorld(true);
    reference.rig.skeleton.update();

    for (let bone = 0; bone < assets.boneCount; bone++) {
      referencePosition.setFromMatrixPosition(reference.rig.bones[bone].matrixWorld);
      getBonePositionFromMatrices(evaluator.modelBoneMatrices, id, bone, assets.boneCount, batchPosition);
      maxBoneError = Math.max(maxBoneError, referencePosition.distanceTo(batchPosition));

      const matrixOffset = (id * assets.boneCount + bone) * 16;
      model.fromArray(evaluator.modelBoneMatrices, matrixOffset);
      inverseBind.fromArray(assets.rest.inverseBindMatrices, bone * 16);
      expected.multiplyMatrices(model, inverseBind);
      for (let element = 0; element < 16; element++) {
        maxIndexError = Math.max(maxIndexError, Math.abs(expected.elements[element] - evaluator.skinMatrices[matrixOffset + element]));
        maxReferenceSkinError = Math.max(
          maxReferenceSkinError,
          Math.abs(reference.rig.skeleton.boneMatrices[bone * 16 + element] - evaluator.skinMatrices[matrixOffset + element])
        );
      }
    }

    getBonePositionFromMatrices(evaluator.modelBoneMatrices, id, 0, assets.boneCount, tmpVectorA);
    getBonePositionFromMatrices(evaluator.modelBoneMatrices, id, 4, assets.boneCount, tmpVectorB);
    signatures.add(`${tmpVectorA.x.toFixed(4)},${tmpVectorA.y.toFixed(4)},${tmpVectorA.z.toFixed(4)}|${tmpVectorB.x.toFixed(4)},${tmpVectorB.y.toFixed(4)},${tmpVectorB.z.toFixed(4)}`);
  }

  const loopGap = measureLoopBoundaryGap();
  referenceDirty = true;
  updateReferencePose();

  const pass = maxBoneError < 1e-3 && maxIndexError < 1e-5 && maxReferenceSkinError < 1e-3 && maxInstanceIdError === 0 && loopGap < 0.02 && signatures.size === sampleIds.length;
  checkResult.className = `check-result ${pass ? 'pass' : 'fail'}`;
  checkResult.textContent = [
    pass ? 'PASS：批处理姿态、独立参考路径和索引布局一致。' : 'FAIL：检测到姿态或索引不一致。',
    `样本实例: ${sampleIds.map((id) => `#${id}`).join(', ')}`,
    `最大骨骼位置误差: ${maxBoneError.toExponential(3)} m`,
    `参考蒙皮矩阵误差: ${maxReferenceSkinError.toExponential(3)}`,
    `骨骼纹理索引误差: ${maxIndexError.toExponential(3)}`,
    `实例 ID 属性误差: ${maxInstanceIdError.toExponential(3)}`,
    `循环边界最大跳变: ${loopGap.toExponential(3)} m`,
    `独立姿态签名: ${signatures.size}/${sampleIds.length}`
  ].join('\n');
}

function measureLoopBoundaryGap() {
  const duration = assets.clip.duration;
  const epsilon = 0.0005;
  const before = [new THREE.Vector3(), new THREE.Vector3()];
  const after = [new THREE.Vector3(), new THREE.Vector3()];

  reference.rig.mixer.setTime(duration - epsilon);
  reference.rig.mesh.updateMatrixWorld(true);
  before[0].setFromMatrixPosition(reference.rig.bones[0].matrixWorld);
  before[1].setFromMatrixPosition(reference.rig.bones[4].matrixWorld);

  reference.rig.mixer.setTime(duration + epsilon);
  reference.rig.mesh.updateMatrixWorld(true);
  after[0].setFromMatrixPosition(reference.rig.bones[0].matrixWorld);
  after[1].setFromMatrixPosition(reference.rig.bones[4].matrixWorld);

  return Math.max(before[0].distanceTo(after[0]), before[1].distanceTo(after[1]));
}

function getAnimationTime(config) {
  const duration = assets.clip.duration;
  const time = config.animPhase * duration + simTime * config.animSpeed;
  return ((time % duration) + duration) % duration;
}

function getHeadingDegrees(config) {
  const lane = config.lane;
  const radiusX = 9.2 + lane * 1.45 + config.radialOffset;
  const radiusZ = 7.2 + lane * 1.18 + config.radialOffset * 0.7;
  const angle = config.orbitPhase * Math.PI * 2 + simTime * config.orbitSpeed;
  const direction = Math.sign(config.orbitSpeed);
  const tangentX = -radiusX * Math.sin(angle) * direction;
  const tangentZ = radiusZ * Math.cos(angle) * direction;
  return THREE.MathUtils.radToDeg(Math.atan2(tangentX, tangentZ));
}

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();

  const rect = referenceCanvas.getBoundingClientRect();
  const refWidth = Math.max(1, Math.floor(rect.width));
  const refHeight = Math.max(1, Math.floor(rect.height));
  reference.renderer.setSize(refWidth, refHeight, false);
  reference.camera.aspect = refWidth / refHeight;
  reference.camera.updateProjectionMatrix();
}

function getHardwareInfo() {
  const gl = renderer.getContext();
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = debugInfo
    ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
    : String(gl.getParameter(gl.RENDERER));
  return {
    gpu: gpu || 'Unknown GPU',
    cores: navigator.hardwareConcurrency || 'unknown',
    dpr: Math.min(window.devicePixelRatio || 1, 2)
  };
}

function pushSample(array, value) {
  array.push(value);
  if (array.length > STATS_WINDOW) array.shift();
}

function average(array) {
  if (array.length === 0) return 0;
  let sum = 0;
  for (const value of array) sum += value;
  return sum / array.length;
}

function percentile(array, p) {
  if (array.length === 0) return 0;
  const sorted = [...array].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function hash01(index, salt) {
  const value = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453123;
  return value - Math.floor(value);
}
