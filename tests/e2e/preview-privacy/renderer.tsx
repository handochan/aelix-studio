import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import ImageViewer from '@/renderer/pages/conversation/Preview/components/viewers/ImageViewer';
import { downloadFileFromRef } from '@/renderer/utils/file/download';
import type { ChatFileRef } from '@/common/types/chatFile';

export type PreviewPrivacyHarness = {
  download: typeof downloadFileFromRef;
  openImage: (props: { content?: string; fileRef?: ChatFileRef }) => void;
};

const root = createRoot(document.getElementById('preview')!);
let imageId = 0;
Object.assign(window, {
  previewPrivacy: {
    download: downloadFileFromRef,
    openImage: (props) => flushSync(() => root.render(<ImageViewer key={++imageId} {...props} />)),
  } satisfies PreviewPrivacyHarness,
});
