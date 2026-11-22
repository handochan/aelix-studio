import type { ImageFailureCode, ImagePreparationMeasurements } from './Images';
import type { Dimensions, ImageProgress } from './Images/types';
import type { RunningImageRejection, RunningImageState } from './imageProtocol';
import type { RelayFailure } from './transport';

export type RunningInputMode = 'steer' | 'follow-up';
export type RunningInputTarget = Readonly<{ bindingId: string; turnId: string }>;
export type RunningInputTurn = { active: true; turnId: string } | { active: false; turnId: null };

export type RunningInputOutcome =
  | { status: 'queued'; captionAdded?: boolean }
  | { status: 'rejected'; reason: RunningImageRejection }
  | { status: 'rejected'; failure: RelayFailure }
  | { status: 'unknown'; failure?: RelayFailure };

/** Metadata for the display-oriented original and the immutable transmitted image. */
export type RunningImageDetails = Readonly<{
  original: Readonly<Dimensions & { bytes: number }>;
  sent: Readonly<Dimensions & { bytes: number; sha256: string }>;
  downscaled: boolean;
  orientationOnly: boolean;
}>;

export type RunningImageBatch = Readonly<{
  images: readonly RunningImageDetails[];
  estimatedLineBytes: number;
}>;

export type RunningInputReceipt = Readonly<
  RunningInputTarget & {
    requestId: string;
    mode: RunningInputMode;
    /** Host turn observed at the original click. Local metadata for Stop attribution. */
    hostTurnId?: string | null;
    /** Present for a pixel write. Receipt and preview can be inspected on the original binding and turn. */
    pixels?: RunningImageBatch;
  } & (RunningInputOutcome | { status: 'pending' })
>;

export type RunningImageBlockReason =
  | ImageFailureCode
  | 'contract-unavailable'
  | 'model-text-only'
  | 'model-unverified'
  | 'state-unavailable'
  | 'model-changed'
  | 'turn-changed'
  | 'grant-unavailable'
  | 'image-count'
  | 'invalid-text'
  | 'references-unverified';

export type ImageSubmissionIdentity = RunningInputTarget & { mode: RunningInputMode; requestId: string };

/**
 * Local pre-dispatch state for the composer. Pending, queued, rejected and unknown
 * move to receipts (pixels field). A blocked submission preserves all original chips.
 */
export type RunningImageSubmission = Readonly<
  ImageSubmissionIdentity & { batch?: RunningImageBatch; measurements?: ImagePreparationMeasurements } & (
      | { status: 'preparing'; stage: 'references'; fileCount: number }
      | {
          status: 'preparing';
          stage: 'images';
          imageCount: number;
          progress?: Readonly<{ index: number; image: ImageProgress }>;
        }
      | { status: 'blocked'; reason: RunningImageBlockReason; allowPathOnly: boolean }
    )
>;

export type RunningInputSnapshot = Readonly<{
  channel:
    | { status: 'unknown' | 'checking' | 'unsupported' | 'no-live-task' }
    | { status: 'unavailable'; failure?: RelayFailure }
    | {
        status: 'ready';
        bindingId: string;
        /** Host turn ID that stayed current across this successful ACP discovery. */
        hostTurnId: string | null;
        turn: RunningInputTurn;
        modes: readonly RunningInputMode[];
        canLookup: boolean;
        pixelModes?: readonly RunningInputMode[];
      };
  /** Capability discovery succeeded, even if the subsequent state read failed. */
  negotiated: boolean;
  receipts: readonly RunningInputReceipt[];
  sending: boolean;
  imageState?: RunningImageState;
  imageSubmission?: RunningImageSubmission;
}>;

export type RunningInputSendResult =
  | { status: 'skipped'; reason: 'busy' | 'unavailable' | 'invalid-text' | 'too-large'; preserveDraft: true }
  | { status: 'blocked'; preserveDraft: true }
  | { status: 'sent'; receipt: RunningInputReceipt; preserveDraft: boolean };

export type RunningInputLookupResult =
  | { status: 'completed'; receipt: RunningInputReceipt }
  | { status: 'pending' }
  | { status: 'unknown' | 'unavailable' | 'binding-changed'; refreshHistory: true };
