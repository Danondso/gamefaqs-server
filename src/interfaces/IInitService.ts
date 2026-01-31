import type { InitStatus, InitStatusCallback } from '../types';

export interface IInitService {
  getStatus(): InitStatus;
  isComplete(): boolean;
  hasError(): boolean;
  onStatusChange(callback: InitStatusCallback): () => void;
}
