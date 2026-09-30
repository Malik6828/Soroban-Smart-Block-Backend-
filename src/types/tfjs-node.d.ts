/**
 * Ambient declaration for the optional @tensorflow/tfjs-node package. The
 * native TensorFlow runtime is an optional dependency used only by the
 * predictive-model service; this keeps typechecking green without forcing the
 * heavyweight native binary into every install.
 */
declare module '@tensorflow/tfjs-node' {
  export interface History {
    history: Record<string, number[]>;
  }

  export interface LayersModel {
    predict(input: unknown): unknown;
    compile(config: object): void;
    fit(x: unknown, y: unknown, config?: object): Promise<History>;
    save(path: string): Promise<unknown>;
    dispose(): void;
  }

  export interface Sequential extends LayersModel {
    add(layer: unknown): void;
  }

  export function loadLayersModel(path: string): Promise<LayersModel>;
  export function sequential(config?: object): Sequential;

  export const layers: {
    lstm(config: object): unknown;
    dropout(config: object): unknown;
    dense(config: object): unknown;
    input(config: object): unknown;
    reshape(config: object): unknown;
  };

  export const train: {
    adam(config?: object): unknown;
  };

  export interface Tensor {
    dispose(): void;
    shape: number[];
    dataSync(): Float32Array;
    data(): Promise<Uint8Array | Float32Array | Int32Array>;
  }

  export const tensor2d: {
    (values: number[][], shape?: [number, number]): Tensor;
  };

  export const tensor3d: {
    (values: number[][][], shape?: [number, number, number]): Tensor;
  };

  export const reshape: {
    (tensor: unknown, shape: number[]): unknown;
  };

  export function ready(): Promise<void>;
}
