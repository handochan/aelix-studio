/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { ChatFileRef } from '@/common/types/chatFile';
import { isValidImageSource } from '@/renderer/utils/file/base64';
import { Image } from '@arco-design/web-react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface ImagePreviewProps {
  fileRef?: ChatFileRef;
  file_path?: string;
  content?: string;
  file_name?: string;
  workspace?: string;
}

const ImagePreview: React.FC<ImagePreviewProps> = ({ fileRef, file_path, content, file_name, workspace }) => {
  const { t } = useTranslation();
  const [source, setSource] = useState<string>(content || '');
  const [loading, setLoading] = useState<boolean>((!!fileRef || !!file_path) && !content);
  const [error, setError] = useState(false);
  const validSource = useMemo(() => !source || isValidImageSource(source), [source]);

  useEffect(() => {
    let isMounted = true;

    const loadImage = async () => {
      if (content) {
        setSource(content);
        setLoading(false);
        setError(false);
        return;
      }

      if (!fileRef && !file_path) {
        setSource('');
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        setError(false);
        // Prefer the ChatFileRef identity (data-URL from /api/fs/content); fall back
        // to the legacy {path, workspace} image endpoint for callers not yet migrated.
        const base64 = fileRef
          ? await ipcBridge.fs.readContent.invoke({ file: fileRef, encoding: 'dataurl' })
          : await ipcBridge.fs.getImageBase64.invoke({ path: file_path!, workspace });
        if (!base64) {
          throw new Error('Image file not found');
        }
        if (!isMounted) return;
        setSource(base64);
      } catch {
        if (!isMounted) return;
        console.error('[ImagePreview] Failed to load image');
        setError(true);
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    void loadImage();

    return () => {
      isMounted = false;
    };
  }, [content, fileRef, file_path, workspace]);

  const renderStatus = () => {
    if (loading) {
      return <div className='text-14px text-t-secondary'>{t('common.loading', { defaultValue: 'Loading...' })}</div>;
    }

    if (error || !validSource) {
      return (
        <div className='text-center text-14px text-t-secondary'>
          <div>{t('messages.imageLoadFailed', { defaultValue: 'Failed to load image' })}</div>
          {file_path && <div className='text-12px'>{file_path}</div>}
        </div>
      );
    }

    return (
      <Image
        src={source}
        alt={file_name || file_path || 'Image preview'}
        className='w-full h-full flex items-center justify-center [&_.arco-image-img]:w-full [&_.arco-image-img]:h-full [&_.arco-image-img]:object-contain'
        preview={!!source}
      />
    );
  };

  return <div className='flex-1 flex items-center justify-center bg-bg-1 p-24px overflow-auto'>{renderStatus()}</div>;
};

export default ImagePreview;
