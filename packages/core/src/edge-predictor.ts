import type { MemoryNode, NodeType } from "./interfaces.ts";

export interface FeatureWeights {
  jaccardOverlap: number;
  sharedEntityCount: number;
  typeSimilarity: number;
  temporalProximity: number;
  contentLengthRatio: number;
  importanceProduct: number;
}

export interface Features {
  jaccardOverlap: number;
  sharedEntityCount: number;
  typeSimilarity: number;
  temporalProximity: number;
  contentLengthRatio: number;
  importanceProduct: number;
}

const COMPATIBLE_TYPE_PAIRS = new Set<string>([
  "concept-assertion",
  "concept-definition",
  "assertion-definition",
]);

export class EdgeWeightPredictor {
  private weights: FeatureWeights;

  constructor(customWeights?: Partial<FeatureWeights>) {
    this.weights = {
      jaccardOverlap: 0.3,
      sharedEntityCount: 0.25,
      typeSimilarity: 0.15,
      temporalProximity: 0.15,
      contentLengthRatio: 0.05,
      importanceProduct: 0.1,
      ...customWeights,
    };
  }

  predict(nodeA: MemoryNode, nodeB: MemoryNode): number {
    const features = this.extractFeatures(nodeA, nodeB);
    return this.score(features);
  }

  private extractFeatures(a: MemoryNode, b: MemoryNode): Features {
    return {
      jaccardOverlap: this.computeJaccard(a.content, b.content),
      sharedEntityCount: this.countSharedEntities(a.content, b.content),
      typeSimilarity: this.typeScore(a.type, b.type),
      temporalProximity: this.temporalScore(a.createdAt, b.createdAt),
      contentLengthRatio: this.lengthRatio(a.content, b.content),
      importanceProduct: a.importance * b.importance,
    };
  }

  private score(features: Features): number {
    let sum = 0;
    sum += this.weights.jaccardOverlap * features.jaccardOverlap;
    sum += this.weights.sharedEntityCount * Math.min(features.sharedEntityCount / 5, 1);
    sum += this.weights.typeSimilarity * features.typeSimilarity;
    sum += this.weights.temporalProximity * features.temporalProximity;
    sum += this.weights.contentLengthRatio * features.contentLengthRatio;
    sum += this.weights.importanceProduct * features.importanceProduct;
    // Sigmoid squash centered at 0.3: pairs need raw sum > 0.3 to exceed weight 0.5
    return 1 / (1 + Math.exp(-5 * (sum - 0.3)));
  }

  private computeJaccard(a: string, b: string): number {
    const tokA = new Set(
      a
        .toLowerCase()
        .split(/[\s\p{P}]+/u)
        .filter((w) => w.length > 2),
    );
    const tokB = new Set(
      b
        .toLowerCase()
        .split(/[\s\p{P}]+/u)
        .filter((w) => w.length > 2),
    );
    if (tokA.size === 0 || tokB.size === 0) return 0;
    let intersect = 0;
    for (const w of tokA) if (tokB.has(w)) intersect++;
    return intersect / (tokA.size + tokB.size - intersect);
  }

  private countSharedEntities(a: string, b: string): number {
    const entA = new Set(a.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)*/g) ?? []);
    const entB = new Set(b.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)*/g) ?? []);
    let shared = 0;
    for (const e of entA) if (entB.has(e)) shared++;
    return shared;
  }

  private typeScore(typeA: NodeType, typeB: NodeType): number {
    if (typeA === typeB) return 1.0;
    const key = [typeA, typeB].sort().join("-");
    return COMPATIBLE_TYPE_PAIRS.has(key) ? 0.7 : 0.3;
  }

  private temporalScore(tsA: number, tsB: number): number {
    const diffHours = Math.abs(tsA - tsB) / 3_600_000;
    if (diffHours < 1) return 1.0;
    if (diffHours < 24) return 0.8;
    if (diffHours < 168) return 0.5;
    return 0.2;
  }

  private lengthRatio(a: string, b: string): number {
    const la = a.length;
    const lb = b.length;
    if (la === 0 || lb === 0) return 0;
    return Math.min(la, lb) / Math.max(la, lb);
  }
}
