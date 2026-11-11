import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const FOG_COLOR = new THREE.Color(0x9fb4c9);
const FOG_NEAR = 34;
const FOG_FAR = 92;
const SUN_DIRECTION = new THREE.Vector3(-0.45, 0.82, 0.35).normalize();

export function createCity(scene) {
  const group = new THREE.Group();
  group.name = 'ProceduralCity';

  const ground = createGround();
  const buildings = createBuildings();
  const trees = createTrees();
  const lamps = createLamps();
  const fountain = createFountain();

  group.add(ground, buildings, trees, lamps.poles, lamps.heads, fountain.stone, fountain.water);
  scene.add(group);

  return { group, ground, buildings, trees, lamps, fountain };
}

function createGround() {
  const geometry = new THREE.PlaneGeometry(96, 96, 1, 1);
  geometry.rotateX(-Math.PI / 2);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uFogColor: { value: FOG_COLOR },
      uFogNear: { value: FOG_NEAR },
      uFogFar: { value: FOG_FAR }
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uFogColor;
      uniform float uFogNear;
      uniform float uFogFar;
      varying vec3 vWorldPosition;

      float lineMask(float value, float width) {
        float centered = abs(fract(value) - 0.5);
        return 1.0 - smoothstep(width, width + 0.015, centered);
      }

      void main() {
        vec2 p = vWorldPosition.xz;
        float d = length(p);
        vec3 asphalt = vec3(0.105, 0.125, 0.145);
        vec3 sidewalk = vec3(0.34, 0.36, 0.36);
        vec3 plaza = vec3(0.42, 0.43, 0.40);
        vec3 park = vec3(0.12, 0.30, 0.18);
        vec3 road = vec3(0.075, 0.085, 0.095);

        vec3 color = asphalt;
        color = mix(color, sidewalk, smoothstep(20.0, 21.0, d) * (1.0 - smoothstep(28.0, 29.0, d)));
        color = mix(color, plaza, 1.0 - smoothstep(20.0, 21.0, d));
        color = mix(color, park, 1.0 - smoothstep(6.4, 7.0, d));

        float ringLine = lineMask(d / 1.55, 0.018) * (1.0 - smoothstep(20.0, 21.0, d));
        color = mix(color, vec3(0.52, 0.50, 0.44), ringLine * 0.28);

        float radial = lineMask(atan(p.y, p.x) / 6.2831853 * 24.0, 0.012) * (1.0 - smoothstep(19.0, 20.0, d));
        color = mix(color, vec3(0.50, 0.49, 0.45), radial * 0.16);

        float outerRoad = smoothstep(28.0, 28.8, d) * (1.0 - smoothstep(34.0, 34.8, d));
        color = mix(color, road, outerRoad);
        float lane = lineMask((d - 28.0) / 6.8, 0.006) * outerRoad;
        color = mix(color, vec3(0.85, 0.72, 0.32), lane * 0.65);

        float gridX = lineMask(p.x / 8.0, 0.01);
        float gridY = lineMask(p.y / 8.0, 0.01);
        float cityGrid = max(gridX, gridY) * smoothstep(35.0, 36.0, d);
        color = mix(color, vec3(0.16, 0.18, 0.19), cityGrid * 0.35);

        float fogFactor = smoothstep(uFogNear, uFogFar, length(vWorldPosition - cameraPosition));
        color = mix(color, uFogColor, fogFactor);
        gl_FragColor = vec4(color, 1.0);
        #include <colorspace_fragment>
      }
    `
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Ground';
  mesh.position.y = -0.025;
  return mesh;
}

function createBuildings() {
  const geometry = new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uSunDirection: { value: SUN_DIRECTION },
      uFogColor: { value: FOG_COLOR },
      uFogNear: { value: FOG_NEAR },
      uFogFar: { value: FOG_FAR }
    },
    vertexShader: `
      varying vec3 vLocalPosition;
      varying vec3 vLocalNormal;
      varying vec3 vWorldPosition;
      varying vec3 vWorldNormal;
      varying vec3 vInstanceColor;

      void main() {
        vLocalPosition = position;
        vLocalNormal = normal;
        vec4 worldPosition = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
        vInstanceColor = instanceColor;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uSunDirection;
      uniform vec3 uFogColor;
      uniform float uFogNear;
      uniform float uFogFar;
      varying vec3 vLocalPosition;
      varying vec3 vLocalNormal;
      varying vec3 vWorldPosition;
      varying vec3 vWorldNormal;
      varying vec3 vInstanceColor;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }

      void main() {
        vec3 normal = normalize(vWorldNormal);
        float diffuse = max(dot(normal, uSunDirection), 0.0);
        float ambient = 0.38 + 0.18 * max(normal.y, 0.0);
        vec3 base = vInstanceColor * (0.72 + 0.18 * hash(floor(vWorldPosition.xz)));

        if (abs(vLocalNormal.y) < 0.5) {
          vec2 facade = abs(vLocalNormal.x) > 0.5 ? vec2(vLocalPosition.z, vLocalPosition.y) : vec2(vLocalPosition.x, vLocalPosition.y);
          vec2 cells = vec2(5.0, 9.0);
          vec2 cell = fract((facade + 0.5) * cells);
          vec2 cellId = floor((facade + 0.5) * cells);
          float windowMask = step(0.22, cell.x) * step(cell.x, 0.58) * step(0.24, cell.y) * step(cell.y, 0.68);
          float lit = step(0.58, hash(cellId + floor(vWorldPosition.xz * 0.37)));
          vec3 windowColor = mix(vec3(0.08, 0.12, 0.16), vec3(1.0, 0.68, 0.28), lit);
          base = mix(base, windowColor, windowMask * 0.88);
        } else {
          base *= 0.62;
        }

        vec3 color = base * (ambient + diffuse * 0.72);
        float fogFactor = smoothstep(uFogNear, uFogFar, length(vWorldPosition - cameraPosition));
        color = mix(color, uFogColor, fogFactor);
        gl_FragColor = vec4(color, 1.0);
        #include <colorspace_fragment>
      }
    `
  });

  const count = 44;
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.name = 'InstancedBuildings';
  mesh.frustumCulled = false;

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const color = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const ring = i % 2;
    const angle = (i / count) * Math.PI * 2 + hash01(i, 3) * 0.08;
    const radius = ring === 0 ? 36 + hash01(i, 4) * 4 : 43 + hash01(i, 5) * 5;
    const width = 3.2 + hash01(i, 6) * 3.4;
    const depth = 3.0 + hash01(i, 7) * 3.8;
    const height = 5.5 + hash01(i, 8) * (ring === 0 ? 10 : 16);

    position.set(Math.cos(angle) * radius, height * 0.5 - 0.02, Math.sin(angle) * radius);
    quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle + Math.PI * 0.5);
    scale.set(width, height, depth);
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(i, matrix);

    color.setHSL(0.56 + hash01(i, 9) * 0.08, 0.18 + hash01(i, 10) * 0.12, 0.34 + hash01(i, 11) * 0.18);
    mesh.setColorAt(i, color);
  }

  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  return mesh;
}

function createTrees() {
  const trunk = new THREE.CylinderGeometry(0.09, 0.13, 0.8, 6, 1);
  trunk.translate(0, 0.4, 0);
  paintGeometry(trunk, new THREE.Color(0x5b3a24));

  const crown = new THREE.ConeGeometry(0.62, 1.45, 7, 2);
  crown.translate(0, 1.35, 0);
  paintGeometry(crown, new THREE.Color(0x1f6b3a));

  const geometry = mergeGeometries([trunk, crown], false);
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  const count = 34;
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.name = 'InstancedTrees';
  mesh.frustumCulled = false;

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();

  for (let i = 0; i < count; i++) {
    const inner = i < 14;
    const angle = hash01(i, 20) * Math.PI * 2;
    const radius = inner ? 2.2 + hash01(i, 21) * 3.4 : 22.5 + hash01(i, 22) * 4.2;
    const size = inner ? 0.75 + hash01(i, 23) * 0.35 : 0.95 + hash01(i, 24) * 0.55;
    position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
    quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), hash01(i, 25) * Math.PI * 2);
    scale.setScalar(size);
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(i, matrix);
  }

  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

function createLamps() {
  const poleGeometry = new THREE.CylinderGeometry(0.035, 0.05, 2.6, 6, 1);
  poleGeometry.translate(0, 1.3, 0);
  const poleMaterial = new THREE.MeshStandardMaterial({ color: 0x303844, roughness: 0.65, metalness: 0.35 });

  const headGeometry = new THREE.SphereGeometry(0.16, 8, 6);
  headGeometry.translate(0, 2.68, 0);
  const headMaterial = new THREE.MeshBasicMaterial({ color: 0xffd28a });

  const count = 18;
  const poles = new THREE.InstancedMesh(poleGeometry, poleMaterial, count);
  const heads = new THREE.InstancedMesh(headGeometry, headMaterial, count);
  poles.name = 'InstancedLampPoles';
  heads.name = 'InstancedLampHeads';
  poles.frustumCulled = false;
  heads.frustumCulled = false;

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);

  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const radius = i % 2 === 0 ? 20.8 : 27.2;
    position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
    quaternion.identity();
    matrix.compose(position, quaternion, scale);
    poles.setMatrixAt(i, matrix);
    heads.setMatrixAt(i, matrix);
  }

  poles.instanceMatrix.needsUpdate = true;
  heads.instanceMatrix.needsUpdate = true;
  return { poles, heads };
}

function createFountain() {
  const stone = new THREE.Mesh(
    new THREE.CylinderGeometry(2.0, 2.2, 0.45, 24, 1),
    new THREE.MeshStandardMaterial({ color: 0x6f7880, roughness: 0.82, metalness: 0.05 })
  );
  stone.name = 'FountainStone';
  stone.position.y = 0.22;

  const water = new THREE.Mesh(
    new THREE.CircleGeometry(1.72, 32),
    new THREE.MeshBasicMaterial({ color: 0x4cc9f0, transparent: true, opacity: 0.72 })
  );
  water.name = 'FountainWater';
  water.rotation.x = -Math.PI / 2;
  water.position.y = 0.47;

  return { stone, water };
}

function paintGeometry(geometry, color) {
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
}

function hash01(index, salt) {
  const value = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453123;
  return value - Math.floor(value);
}
