import { Button } from '@arco-design/web-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

type RemoteImageProps = { src: string; alt?: string; className?: string };

function RemoteImageContent({ src, alt, className }: RemoteImageProps): React.ReactElement {
  const { t } = useTranslation();
  const [requested, setRequested] = useState(false);
  const [failed, setFailed] = useState(false);
  const url = src.startsWith('//') ? `https:${src}` : src;
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    host = url;
  }
  if (requested && !failed) {
    return (
      <img
        src={url}
        alt={alt ?? ''}
        className={className}
        referrerPolicy='no-referrer'
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span className='inline-flex flex-col gap-4px text-t-secondary' title={url}>
      {failed && <span role='status'>{t('messages.imageLoadFailed')}</span>}
      <Button
        size='small'
        onClick={() => {
          setFailed(false);
          setRequested(true);
        }}
      >
        {t('common.download')} · {alt ? `${alt} (${host})` : host}
      </Button>
    </span>
  );
}

/** Require a fresh user action for each source; streamed replacements never inherit consent. */
export default function RemoteImage(props: RemoteImageProps): React.ReactElement {
  return <RemoteImageContent key={props.src} {...props} />;
}
