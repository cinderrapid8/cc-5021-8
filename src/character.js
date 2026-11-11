import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const PART_SKIN = 0;
export const PART_SHIRT = 1;
export const PART_PANTS = 2;
export const PART_SHOES = 3;
export const PART_HAIR = 4;

export const BONE_DEFINITIONS = [
  { name: 'Hips', parent: -1, position: [0, 0.92, 0] },
  { name: 'Spine', parent: 0, position: [0, 0.18, 0] },
  { name: 'Chest', parent: 1, position: [0, 0.20, 0] },
  { name: 'Neck', parent: 2, position: [0, 0.22, 0] },
  { name: 'Head', parent: 3, position: [0, 0.14, 0] },
  { name: 'UpperArmL', parent: 2, position: [0.30, 0.16, 0] },
  { name: 'LowerArmL', parent: 5, position: [0, -0.32, 0] },
  { name: 'HandL', parent: 6, position: [0, -0.30, 0] },
  { name: 'UpperArmR', parent: 2, position: [-0.30, 0.16, 0] },
  { name: 'LowerArmR', parent: 8, position: [0, -0.32, 0] },
  { name: 'HandR', parent: 9, position: [0, -0.30, 0] },
  { name: 'UpperLegL', parent: 0, position: [0.11, -0.02, 0] },
  { name: 'LowerLegL', parent: 11, position: [0, -0.42, 0] },
  { name: 'FootL', parent: 12, position: [0, -0.40, 0.04] },
  { name: 'UpperLegR', parent: 0, position: [-0.11, -0.02, 0] },
  { name: 'LowerLegR', parent: 14, position: [0, -0.42, 0] },
  { name: 'FootR', parent: 15, position: [0, -0.40, 0.04] }
];

const BONE_COUNT = BONE_DEFINITIONS.length;
const IDENTITY_QUATERNION = [0, 0, 0, 1];
const BONE_DEPTHS = computeBoneDepths();

export const SKELETON_DETAIL_FULL = 0;
export const SKELETON_DETAIL_MEDIUM = 1;
export const SKELETON_DETAIL_COARSE = 2;
export const SKELETON_DETAIL_LEVELS = [
  { name: 'full', maxDepth: Number.POSITIVE_INFINITY },
  { name: 'medium', maxDepth: 3 },
  { name: 'coarse', maxDepth: 1 }
];
export const SKELETON_DETAIL_DISTANCE_THRESHOLDS = [34, 60];
export const SKELETON_DETAIL_HYSTERESIS = 2.5;

const SKELETON_DETAIL_MASKS = SKELETON_DETAIL_LEVELS.map((level) => {
  const mask = new Uint8Array(BONE_COUNT);
  for (let bone = 0; bone < BONE_COUNT; bone++) {
    mask[bone] = BONE_DEPTHS[bone] <= level.maxDepth ? 1 : 0;
  }
  return mask;
});

function computeBoneDepths() {
  const depths = new Int8Array(BONE_COUNT).fill(-1);

  const resolveDepth = (boneIndex, visiting) => {
    if (depths[boneIndex] >= 0) return depths[boneIndex];
    if (visiting[boneIndex]) throw new Error(`Cyclic bone hierarchy at ${BONE_DEFINITIONS[boneIndex].name}`);
    visiting[boneIndex] = 1;
    const parent = BONE_DEFINITIONS[boneIndex].parent;
    if (parent !== -1 && (parent < 0 || parent >= BONE_COUNT)) {
      throw new Error(`Invalid parent for bone ${BONE_DEFINITIONS[boneIndex].name}`);
    }
    depths[boneIndex] = parent === -1 ? 0 : resolveDepth(parent, visiting) + 1;
    visiting[boneIndex] = 0;
    return depths[boneIndex];
  };

  const visiting = new Uint8Array(BONE_COUNT);
  for (let bone = 0; bone < BONE_COUNT; bone++) resolveDepth(bone, visiting);
  return depths;
}

export function getSkeletonDetailMask(detailLevel) {
  assertDetailLevel(detailLevel);
  return SKELETON_DETAIL_MASKS[detailLevel];
}

export function getSkeletonDetailName(detailLevel) {
  assertDetailLevel(detailLevel);
  return SKELETON_DETAIL_LEVELS[detailLevel].name;
}

export function getSkeletonDetailLevelForDistance(
  distance,
  thresholds = SKELETON_DETAIL_DISTANCE_THRESHOLDS
) {
  if (!Number.isFinite(distance) || distance < 0) {
    throw new RangeError(`Skeleton detail distance must be a finite non-negative number, got ${distance}`);
  }
  assertDetailThresholds(thresholds);
  let detailLevel = 0;
  while (detailLevel < thresholds.length && distance >= thresholds[detailLevel]) detailLevel++;
  return detailLevel;
}

export function selectSkeletonDetailLevel(
  distance,
  currentLevel = -1,
  thresholds = SKELETON_DETAIL_DISTANCE_THRESHOLDS,
  hysteresis = SKELETON_DETAIL_HYSTERESIS
) {
  const pureLevel = getSkeletonDetailLevelForDistance(distance, thresholds);
  if (currentLevel === null || currentLevel === undefined || currentLevel === -1) return pureLevel;
  assertDetailLevel(currentLevel);
  if (!Number.isFinite(hysteresis) || hysteresis < 0) {
    throw new RangeError(`Skeleton detail hysteresis must be a finite non-negative number, got ${hysteresis}`);
  }
  if (pureLevel === currentLevel) return currentLevel;

  const halfBand = hysteresis * 0.5;
  if (pureLevel > currentLevel) {
    const enterCoarser = thresholds[currentLevel] + halfBand;
    return distance >= enterCoarser ? pureLevel : currentLevel;
  }

  const exitCoarser = thresholds[currentLevel - 1] - halfBand;
  return distance <= exitCoarser ? pureLevel : currentLevel;
}

export function applyFullDetailBudget(levels, distances, activeCount, fullDetailBudget) {
  if (!Number.isInteger(activeCount) || activeCount < 0 || activeCount > levels.length || activeCount > distances.length) {
    throw new RangeError(`Invalid budget activeCount ${activeCount}`);
  }
  if (!Number.isInteger(fullDetailBudget) || fullDetailBudget < 0) {
    throw new RangeError(`Invalid full-detail budget ${fullDetailBudget}`);
  }

  const candidates = [];
  for (let instance = 0; instance < activeCount; instance++) {
    assertDetailLevel(levels[instance]);
    if (!Number.isFinite(distances[instance]) || distances[instance] < 0) {
      throw new RangeError(`Invalid skeleton detail distance at instance ${instance}`);
    }
    if (levels[instance] === SKELETON_DETAIL_FULL) candidates.push(instance);
  }

  let demoted = 0;
  if (candidates.length <= fullDetailBudget) return demoted;
  candidates.sort((a, b) => distances[b] - distances[a] || b - a);
  const excess = candidates.length - fullDetailBudget;
  for (let i = 0; i < excess; i++) {
    levels[candidates[i]] = SKELETON_DETAIL_MEDIUM;
    demoted++;
  }
  return demoted;
}

function assertDetailLevel(detailLevel) {
  if (!Number.isInteger(detailLevel) || detailLevel < 0 || detailLevel >= SKELETON_DETAIL_LEVELS.length) {
    throw new RangeError(`Unknown skeleton detail level ${detailLevel}`);
  }
}

function assertDetailThresholds(thresholds) {
  if (!Array.isArray(thresholds) || thresholds.length !== SKELETON_DETAIL_LEVELS.length - 1) {
    throw new RangeError('Skeleton detail thresholds must match the number of detail transitions');
  }
  for (let i = 0; i < thresholds.length; i++) {
    if (!Number.isFinite(thresholds[i]) || thresholds[i] < 0) {
      throw new RangeError(`Invalid skeleton detail threshold at index ${i}`);
    }
    if (i > 0 && thresholds[i] <= thresholds[i - 1]) {
      throw new RangeError('Skeleton detail thresholds must be strictly ascending');
    }
  }
}

export function createCharacterAssets() {
  const rest = computeRestSkeleton();
  const geometry = createCharacterGeometry();
  const clip = createWalkClip();
  return {
    geometry,
    clip,
    rest,
    boneDefinitions: BONE_DEFINITIONS,
    boneCount: BONE_COUNT
  };
}

function computeRestSkeleton() {
  const parents = new Int16Array(BONE_COUNT);
  const restPositions = new Float32Array(BONE_COUNT * 3);
  const restQuaternions = new Float32Array(BONE_COUNT * 4);
  const restWorldMatrices = new Float32Array(BONE_COUNT * 16);
  const inverseBindMatrices = new Float32Array(BONE_COUNT * 16);
  const local = new THREE.Matrix4();
  const world = new THREE.Matrix4();
  const inverse = new THREE.Matrix4();

  for (let i = 0; i < BONE_COUNT; i++) {
    const definition = BONE_DEFINITIONS[i];
    parents[i] = definition.parent;
    restPositions.set(definition.position, i * 3);
    restQuaternions.set(IDENTITY_QUATERNION, i * 4);

    local.compose(
      new THREE.Vector3(...definition.position),
      new THREE.Quaternion(),
      new THREE.Vector3(1, 1, 1)
    );

    if (definition.parent === -1) {
      world.copy(local);
    } else {
      world.fromArray(restWorldMatrices, definition.parent * 16).multiply(local);
    }

    world.toArray(restWorldMatrices, i * 16);
    inverse.copy(world).invert();
    inverse.toArray(inverseBindMatrices, i * 16);
  }

  return {
    parents,
    restPositions,
    restQuaternions,
    restWorldMatrices,
    inverseBindMatrices
  };
}

function createCharacterGeometry() {
  const parts = [];

  addBox(parts, [0.42, 0.22, 0.24], [0, 0.92, 0], 0, PART_PANTS);
  addBox(parts, [0.44, 0.30, 0.24], [0, 1.10, 0], 1, PART_SHIRT);
  addBox(parts, [0.50, 0.38, 0.27], [0, 1.34, 0], 2, PART_SHIRT);
  addBox(parts, [0.14, 0.13, 0.14], [0, 1.57, 0], 3, PART_SKIN);
  addBox(parts, [0.29, 0.32, 0.27], [0, 1.78, 0], 4, PART_SKIN);
  addBox(parts, [0.31, 0.10, 0.29], [0, 1.96, -0.01], 4, PART_HAIR);

  addBox(parts, [0.16, 0.16, 0.16], [0.30, 1.46, 0], 5, PART_SHIRT);
  addBox(parts, [0.14, 0.34, 0.14], [0.30, 1.30, 0], 5, PART_SHIRT);
  addBox(parts, [0.12, 0.32, 0.12], [0.30, 0.99, 0], 6, PART_SKIN);
  addBox(parts, [0.13, 0.14, 0.13], [0.30, 0.80, 0], 7, PART_SKIN);

  addBox(parts, [0.16, 0.16, 0.16], [-0.30, 1.46, 0], 8, PART_SHIRT);
  addBox(parts, [0.14, 0.34, 0.14], [-0.30, 1.30, 0], 8, PART_SHIRT);
  addBox(parts, [0.12, 0.32, 0.12], [-0.30, 0.99, 0], 9, PART_SKIN);
  addBox(parts, [0.13, 0.14, 0.13], [-0.30, 0.80, 0], 10, PART_SKIN);

  addBox(parts, [0.17, 0.44, 0.18], [0.11, 0.69, 0], 11, PART_PANTS);
  addBox(parts, [0.15, 0.41, 0.16], [0.11, 0.28, 0], 12, PART_PANTS);
  addBox(parts, [0.16, 0.10, 0.30], [0.11, 0.05, 0.07], 13, PART_SHOES);

  addBox(parts, [0.17, 0.44, 0.18], [-0.11, 0.69, 0], 14, PART_PANTS);
  addBox(parts, [0.15, 0.41, 0.16], [-0.11, 0.28, 0], 15, PART_PANTS);
  addBox(parts, [0.16, 0.10, 0.30], [-0.11, 0.05, 0.07], 16, PART_SHOES);

  const geometry = mergeGeometries(parts, false);
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}

function addBox(parts, size, center, boneIndex, partType) {
  const geometry = new THREE.BoxGeometry(size[0], size[1], size[2], 1, 1, 1);
  geometry.translate(center[0], center[1], center[2]);
  addSkinAttributes(geometry, boneIndex, partType);
  parts.push(geometry);
}

function addSkinAttributes(geometry, boneIndex, partType) {
  const count = geometry.attributes.position.count;
  const skinIndex = new Float32Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  const part = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    skinIndex[i * 4] = boneIndex;
    skinWeight[i * 4] = 1;
    part[i] = partType;
  }

  geometry.setAttribute('skinIndex', new THREE.Float32BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
  geometry.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
}

function createWalkClip() {
  const duration = 1;
  const keyTimes = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];
  const tracks = [];

  const hipPositions = [];
  for (const time of keyTimes) {
    const p = Math.PI * 2 * time;
    hipPositions.push(
      0.018 * Math.sin(p),
      0.91 + 0.026 * Math.cos(2 * p),
      0
    );
  }
  tracks.push(new THREE.VectorKeyframeTrack('Hips.position', keyTimes, hipPositions));

  const rotation = (boneName, sampler) => {
    const values = [];
    const quaternion = new THREE.Quaternion();
    const previous = new THREE.Quaternion();
    let hasPrevious = false;

    for (const time of keyTimes) {
      const p = Math.PI * 2 * time;
      const euler = sampler(p);
      quaternion.setFromEuler(new THREE.Euler(euler[0], euler[1], euler[2], 'XYZ'));
      if (hasPrevious && quaternion.dot(previous) < 0) {
        quaternion.set(-quaternion.x, -quaternion.y, -quaternion.z, -quaternion.w);
      }
      values.push(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
      previous.copy(quaternion);
      hasPrevious = true;
    }

    tracks.push(new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, keyTimes, values));
  };

  rotation('Hips', (p) => [0.025 * Math.sin(2 * p), 0, 0.055 * Math.sin(p)]);
  rotation('Spine', (p) => [0.045 + 0.018 * Math.sin(2 * p), 0.025 * Math.sin(p), -0.035 * Math.sin(p)]);
  rotation('Chest', (p) => [0.025 * Math.sin(2 * p), -0.035 * Math.sin(p), -0.045 * Math.sin(p)]);
  rotation('Neck', (p) => [-0.025 + 0.015 * Math.sin(2 * p), 0.018 * Math.sin(p), 0.025 * Math.sin(p)]);
  rotation('Head', (p) => [-0.02 * Math.sin(2 * p), 0.025 * Math.sin(p + 0.4), 0.018 * Math.sin(p)]);

  rotation('UpperArmL', (p) => [0.46 * Math.sin(p), 0, 0.10 + 0.025 * Math.sin(2 * p)]);
  rotation('LowerArmL', (p) => [-0.22 - 0.16 * Math.max(0, Math.sin(p)), 0, 0.02 * Math.sin(p)]);
  rotation('UpperArmR', (p) => [-0.46 * Math.sin(p), 0, -0.10 + 0.025 * Math.sin(2 * p)]);
  rotation('LowerArmR', (p) => [-0.22 - 0.16 * Math.max(0, -Math.sin(p)), 0, -0.02 * Math.sin(p)]);

  rotation('UpperLegL', (p) => [-0.56 * Math.sin(p), 0, 0.018 * Math.sin(2 * p)]);
  rotation('LowerLegL', (p) => [0.10 + 0.48 * Math.max(0, -Math.sin(p - 0.18)), 0, 0]);
  rotation('FootL', (p) => [0.20 * Math.sin(p + 0.65) - 0.08, 0, 0]);

  rotation('UpperLegR', (p) => [0.56 * Math.sin(p), 0, -0.018 * Math.sin(2 * p)]);
  rotation('LowerLegR', (p) => [0.10 + 0.48 * Math.max(0, Math.sin(p - 0.18)), 0, 0]);
  rotation('FootR', (p) => [-0.20 * Math.sin(p + 0.65) - 0.08, 0, 0]);

  return new THREE.AnimationClip('ProceduralWalk', duration, tracks);
}

export class CrowdPoseEvaluator {
  constructor(assets, capacity) {
    this.assets = assets;
    this.capacity = capacity;
    this.boneCount = assets.boneCount;
    this.times = new Float32Array(capacity);
    this.localPositions = new Float32Array(capacity * this.boneCount * 3);
    this.localQuaternions = new Float32Array(capacity * this.boneCount * 4);
    this.modelBoneMatrices = new Float32Array(capacity * this.boneCount * 16);
    this.skinMatrices = new Float32Array(capacity * this.boneCount * 16);
    this.localMatrix = new Float32Array(16);
    this.quaternionTracks = [];
    this.vectorTracks = [];
    this.poseTimes = new Float64Array(capacity);
    this.poseLevels = new Uint8Array(capacity);
    this.poseRowByInstance = new Uint32Array(capacity);
    this.defaultDetailLevels = new Uint8Array(capacity);
    for (let instance = 0; instance < capacity; instance++) {
      this.poseRowByInstance[instance] = instance;
      this.defaultDetailLevels[instance] = SKELETON_DETAIL_FULL;
    }

    const boneIndexByName = new Map(assets.boneDefinitions.map((bone, index) => [bone.name, index]));
    for (const track of assets.clip.tracks) {
      const separator = track.name.lastIndexOf('.');
      const boneName = track.name.slice(0, separator);
      const property = track.name.slice(separator + 1);
      const boneIndex = boneIndexByName.get(boneName);
      if (boneIndex === undefined) continue;

      if (property === 'quaternion') {
        this.quaternionTracks.push({ boneIndex, times: track.times, values: track.values });
      } else if (property === 'position') {
        this.vectorTracks.push({ boneIndex, times: track.times, values: track.values });
      }
    }
  }

  evaluate(times, activeCount, detailLevels = null) {
    if (!Number.isInteger(activeCount) || activeCount < 0 || activeCount > this.capacity) {
      throw new RangeError(`Evaluate count ${activeCount} exceeds capacity ${this.capacity}`);
    }
    if (times.length < activeCount) {
      throw new RangeError(`Expected at least ${activeCount} animation times, got ${times.length}`);
    }
    const levels = detailLevels === null ? this.defaultDetailLevels : detailLevels;
    if (levels.length < activeCount) {
      throw new RangeError(`Expected at least ${activeCount} detail levels, got ${levels.length}`);
    }

    for (let instance = 0; instance < activeCount; instance++) {
      const time = times[instance];
      const level = levels[instance];
      if (!Number.isFinite(time)) {
        throw new RangeError(`Animation time for instance ${instance} is not finite: ${time}`);
      }
      assertDetailLevel(level);
      this.poseTimes[instance] = time;
      this.poseLevels[instance] = level;
      this.poseRowByInstance[instance] = instance;
    }

    this.resetLocalPose(activeCount);

    for (const track of this.quaternionTracks) {
      sampleQuaternionTrack(track, times, activeCount, this.localQuaternions, this.boneCount, levels);
    }

    for (const track of this.vectorTracks) {
      sampleVectorTrack(track, times, activeCount, this.localPositions, this.boneCount, levels);
    }

    this.composePose(activeCount);
  }

  getPoseBinding(instance) {
    if (!Number.isInteger(instance) || instance < 0 || instance >= this.capacity) {
      throw new RangeError(`Invalid pose binding instance ${instance}`);
    }
    return {
      row: this.poseRowByInstance[instance],
      time: this.poseTimes[instance],
      detailLevel: this.poseLevels[instance]
    };
  }

  resetLocalPose(activeCount) {
    const { restPositions, restQuaternions } = this.assets.rest;
    for (let instance = 0; instance < activeCount; instance++) {
      const positionBase = instance * this.boneCount * 3;
      const quaternionBase = instance * this.boneCount * 4;
      for (let bone = 0; bone < this.boneCount; bone++) {
        const restPositionOffset = bone * 3;
        const positionOffset = positionBase + restPositionOffset;
        this.localPositions[positionOffset] = restPositions[restPositionOffset];
        this.localPositions[positionOffset + 1] = restPositions[restPositionOffset + 1];
        this.localPositions[positionOffset + 2] = restPositions[restPositionOffset + 2];

        const restQuaternionOffset = bone * 4;
        const quaternionOffset = quaternionBase + restQuaternionOffset;
        this.localQuaternions[quaternionOffset] = restQuaternions[restQuaternionOffset];
        this.localQuaternions[quaternionOffset + 1] = restQuaternions[restQuaternionOffset + 1];
        this.localQuaternions[quaternionOffset + 2] = restQuaternions[restQuaternionOffset + 2];
        this.localQuaternions[quaternionOffset + 3] = restQuaternions[restQuaternionOffset + 3];
      }
    }
  }

  composePose(activeCount) {
    const parents = this.assets.rest.parents;
    const inverseBindMatrices = this.assets.rest.inverseBindMatrices;

    for (let instance = 0; instance < activeCount; instance++) {
      const posePositionBase = instance * this.boneCount * 3;
      const poseQuaternionBase = instance * this.boneCount * 4;
      const modelBase = instance * this.boneCount * 16;

      for (let bone = 0; bone < this.boneCount; bone++) {
        const positionOffset = posePositionBase + bone * 3;
        const quaternionOffset = poseQuaternionBase + bone * 4;
        composeMatrix(
          this.localMatrix,
          0,
          this.localPositions[positionOffset],
          this.localPositions[positionOffset + 1],
          this.localPositions[positionOffset + 2],
          this.localQuaternions[quaternionOffset],
          this.localQuaternions[quaternionOffset + 1],
          this.localQuaternions[quaternionOffset + 2],
          this.localQuaternions[quaternionOffset + 3]
        );

        const modelOffset = modelBase + bone * 16;
        const parent = parents[bone];
        if (parent === -1) {
          this.modelBoneMatrices.set(this.localMatrix, modelOffset);
        } else {
          multiplyMatrices(
            this.modelBoneMatrices,
            modelBase + parent * 16,
            this.localMatrix,
            0,
            this.modelBoneMatrices,
            modelOffset
          );
        }

        multiplyMatrices(
          this.modelBoneMatrices,
          modelOffset,
          inverseBindMatrices,
          bone * 16,
          this.skinMatrices,
          modelOffset
        );
      }
    }
  }
}

function sampleQuaternionTrack(track, times, activeCount, target, boneCount, detailLevels) {
  const trackTimes = track.times;
  const trackValues = track.values;
  const lastIndex = trackTimes.length - 1;

  for (let instance = 0; instance < activeCount; instance++) {
    if (SKELETON_DETAIL_MASKS[detailLevels[instance]][track.boneIndex] === 0) continue;
    const time = wrapTime(times[instance], trackTimes[lastIndex]);
    const keyIndex = findKeyframe(trackTimes, time);
    const nextIndex = Math.min(keyIndex + 1, lastIndex);
    const start = trackTimes[keyIndex];
    const end = trackTimes[nextIndex];
    const alpha = end > start ? (time - start) / (end - start) : 0;
    const targetOffset = (instance * boneCount + track.boneIndex) * 4;

    THREE.Quaternion.slerpFlat(
      target,
      targetOffset,
      trackValues,
      keyIndex * 4,
      trackValues,
      nextIndex * 4,
      alpha
    );
  }
}

function sampleVectorTrack(track, times, activeCount, target, boneCount, detailLevels) {
  const trackTimes = track.times;
  const trackValues = track.values;
  const lastIndex = trackTimes.length - 1;

  for (let instance = 0; instance < activeCount; instance++) {
    if (SKELETON_DETAIL_MASKS[detailLevels[instance]][track.boneIndex] === 0) continue;
    const time = wrapTime(times[instance], trackTimes[lastIndex]);
    const keyIndex = findKeyframe(trackTimes, time);
    const nextIndex = Math.min(keyIndex + 1, lastIndex);
    const start = trackTimes[keyIndex];
    const end = trackTimes[nextIndex];
    const alpha = end > start ? (time - start) / (end - start) : 0;
    const source0 = keyIndex * 3;
    const source1 = nextIndex * 3;
    const targetOffset = (instance * boneCount + track.boneIndex) * 3;

    target[targetOffset] = trackValues[source0] + (trackValues[source1] - trackValues[source0]) * alpha;
    target[targetOffset + 1] = trackValues[source0 + 1] + (trackValues[source1 + 1] - trackValues[source0 + 1]) * alpha;
    target[targetOffset + 2] = trackValues[source0 + 2] + (trackValues[source1 + 2] - trackValues[source0 + 2]) * alpha;
  }
}

function wrapTime(time, duration) {
  const wrapped = time % duration;
  return wrapped < 0 ? wrapped + duration : wrapped;
}

function findKeyframe(times, time) {
  let low = 0;
  let high = times.length - 1;

  if (time <= times[0]) return 0;
  if (time >= times[high]) return high - 1;

  while (low <= high) {
    const middle = (low + high) >> 1;
    if (times[middle] <= time && time < times[middle + 1]) return middle;
    if (times[middle] < time) low = middle + 1;
    else high = middle - 1;
  }

  return times.length - 2;
}

function composeMatrix(out, offset, px, py, pz, qx, qy, qz, qw) {
  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;
  const xx = qx * x2;
  const xy = qx * y2;
  const xz = qx * z2;
  const yy = qy * y2;
  const yz = qy * z2;
  const zz = qz * z2;
  const wx = qw * x2;
  const wy = qw * y2;
  const wz = qw * z2;

  out[offset] = 1 - (yy + zz);
  out[offset + 1] = xy + wz;
  out[offset + 2] = xz - wy;
  out[offset + 3] = 0;

  out[offset + 4] = xy - wz;
  out[offset + 5] = 1 - (xx + zz);
  out[offset + 6] = yz + wx;
  out[offset + 7] = 0;

  out[offset + 8] = xz + wy;
  out[offset + 9] = yz - wx;
  out[offset + 10] = 1 - (xx + yy);
  out[offset + 11] = 0;

  out[offset + 12] = px;
  out[offset + 13] = py;
  out[offset + 14] = pz;
  out[offset + 15] = 1;
}

function multiplyMatrices(a, aOffset, b, bOffset, out, outOffset) {
  const a11 = a[aOffset];
  const a12 = a[aOffset + 4];
  const a13 = a[aOffset + 8];
  const a14 = a[aOffset + 12];
  const a21 = a[aOffset + 1];
  const a22 = a[aOffset + 5];
  const a23 = a[aOffset + 9];
  const a24 = a[aOffset + 13];
  const a31 = a[aOffset + 2];
  const a32 = a[aOffset + 6];
  const a33 = a[aOffset + 10];
  const a34 = a[aOffset + 14];
  const a41 = a[aOffset + 3];
  const a42 = a[aOffset + 7];
  const a43 = a[aOffset + 11];
  const a44 = a[aOffset + 15];

  const b11 = b[bOffset];
  const b12 = b[bOffset + 4];
  const b13 = b[bOffset + 8];
  const b14 = b[bOffset + 12];
  const b21 = b[bOffset + 1];
  const b22 = b[bOffset + 5];
  const b23 = b[bOffset + 9];
  const b24 = b[bOffset + 13];
  const b31 = b[bOffset + 2];
  const b32 = b[bOffset + 6];
  const b33 = b[bOffset + 10];
  const b34 = b[bOffset + 14];
  const b41 = b[bOffset + 3];
  const b42 = b[bOffset + 7];
  const b43 = b[bOffset + 11];
  const b44 = b[bOffset + 15];

  out[outOffset] = a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41;
  out[outOffset + 4] = a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42;
  out[outOffset + 8] = a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43;
  out[outOffset + 12] = a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44;

  out[outOffset + 1] = a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41;
  out[outOffset + 5] = a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42;
  out[outOffset + 9] = a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43;
  out[outOffset + 13] = a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44;

  out[outOffset + 2] = a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41;
  out[outOffset + 6] = a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42;
  out[outOffset + 10] = a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43;
  out[outOffset + 14] = a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44;

  out[outOffset + 3] = a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41;
  out[outOffset + 7] = a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42;
  out[outOffset + 11] = a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43;
  out[outOffset + 15] = a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44;
}

export function createReferenceCharacter(assets, material = undefined) {
  const bones = BONE_DEFINITIONS.map((definition) => {
    const bone = new THREE.Bone();
    bone.name = definition.name;
    bone.position.fromArray(definition.position);
    return bone;
  });

  for (let i = 0; i < bones.length; i++) {
    const parent = BONE_DEFINITIONS[i].parent;
    if (parent !== -1) bones[parent].add(bones[i]);
  }

  const mesh = new THREE.SkinnedMesh(
    assets.geometry,
    material || new THREE.MeshStandardMaterial({ color: 0x7aa2ff, roughness: 0.72, metalness: 0.02 })
  );
  mesh.name = 'ReferenceSkinnedMesh';
  mesh.frustumCulled = false;
  mesh.add(bones[0]);
  mesh.bind(new THREE.Skeleton(bones));

  const mixer = new THREE.AnimationMixer(mesh);
  const action = mixer.clipAction(assets.clip);
  action.play();

  return {
    mesh,
    bones,
    skeleton: mesh.skeleton,
    mixer,
    action
  };
}

export function getBonePositionFromMatrices(matrices, instanceIndex, boneIndex, boneCount, target) {
  const offset = (instanceIndex * boneCount + boneIndex) * 16;
  target.set(matrices[offset + 12], matrices[offset + 13], matrices[offset + 14]);
  return target;
}
