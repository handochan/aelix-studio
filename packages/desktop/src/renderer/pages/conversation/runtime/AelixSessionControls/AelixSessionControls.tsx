/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import RuntimeSelectorPill from '@/renderer/components/agent/RuntimeSelectorPill';
import type { MobileActionSheetEntry } from '@/renderer/components/chat/MobileActionSheet';
import { iconColors } from '@/renderer/styles/colors';
import { Drawer, Popover } from '@arco-design/web-react';
import { Down, Tool, User } from '@icon-park/react';
import type { TFunction } from 'i18next';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { KEY } from './labels';
import ProfilePanel from './ProfilePanel';
import ToolsPanel from './ToolsPanel';
import type { AelixSessionControls as Controls, ControlsPanel } from './useAelixSessionControls';

/** Short state shown on the pill and the mobile sheet row. */
export function controlSummary(t: TFunction, controls: Controls, panel: ControlsPanel): string {
  const { availability } = controls;
  if (availability.kind === 'checking') return t(`${KEY}.summary.checking`);
  if (availability.kind === 'detached') return t(`${KEY}.summary.openFirst`);
  if (availability.kind === 'update-required') return t(`${KEY}.summary.updateRequired`);
  if (availability.kind !== 'ready') return t(`${KEY}.summary.unavailable`);
  const { capabilities } = availability;
  if (panel === 'profile') {
    if (!capabilities.profilesList) return t(`${KEY}.summary.updateRequired`);
    const profiles = controls.profiles;
    return profiles?.activeRef?.name ?? profiles?.activeAgent ?? t(`${KEY}.profile.none`);
  }
  if (!capabilities.selectionsList || !capabilities.setActiveTools) return t(`${KEY}.summary.updateRequired`);
  const override = controls.tools?.toolOverride;
  if (override === undefined) return t(`${KEY}.summary.checking`);
  if (override === null) return t(`${KEY}.tools.inherited`);
  if (override.length === 0) return t(`${KEY}.tools.none`);
  return t(`${KEY}.tools.count`, { total: String(override.length) });
}

const PANEL_TITLES: Record<ControlsPanel, string> = {
  profile: `${KEY}.profile.title`,
  tools: `${KEY}.tools.title`,
};

const PanelBody: React.FC<{ controls: Controls; panel: ControlsPanel }> = ({ controls, panel }) =>
  panel === 'profile' ? <ProfilePanel controls={controls} /> : <ToolsPanel controls={controls} />;

const ControlPill: React.FC<{ controls: Controls; panel: ControlsPanel }> = ({ controls, panel }) => {
  const { t } = useTranslation();
  const open = controls.panel === panel;
  const icon =
    panel === 'profile' ? (
      <User theme='outline' size='14' fill={iconColors.secondary} />
    ) : (
      <Tool theme='outline' size='14' fill={iconColors.secondary} />
    );
  return (
    <Popover
      trigger='click'
      position='top'
      popupVisible={open}
      onVisibleChange={(visible) => controls.openPanel(visible ? panel : null)}
      title={t(PANEL_TITLES[panel])}
      content={
        <div className='w-340px max-w-[80vw] max-h-[60vh] overflow-auto' data-testid={`aelix-${panel}-popover`}>
          <PanelBody controls={controls} panel={panel} />
        </div>
      }
    >
      <span className='inline-flex'>
        <RuntimeSelectorPill
          testId={`aelix-${panel}-pill`}
          className='sendbox-model-btn agent-mode-compact-pill'
          label={`${t(`${KEY}.${panel}.label`)} · ${controlSummary(t, controls, panel)}`}
          leading={<span className='shrink-0 inline-flex items-center'>{icon}</span>}
          trailing={<Down size={12} className='text-t-tertiary shrink-0' />}
          loading={controls.writing !== null}
        />
      </span>
    </Popover>
  );
};

/** Desktop: "Profile" and "This conversation's tools" pills next to the permission selector. */
export const AelixSessionPills: React.FC<{ controls: Controls }> = ({ controls }) => {
  if (!controls.enabled) return null;
  return (
    <>
      <ControlPill controls={controls} panel='profile' />
      <ControlPill controls={controls} panel='tools' />
    </>
  );
};

/** Mobile: the same panels in a bottom drawer, opened from the composer's action sheet. */
export const AelixSessionDrawer: React.FC<{ controls: Controls }> = ({ controls }) => {
  const { t } = useTranslation();
  if (!controls.enabled) return null;
  const { panel } = controls;
  return (
    <Drawer
      placement='bottom'
      height='80%'
      visible={panel !== null}
      title={panel ? t(PANEL_TITLES[panel]) : null}
      footer={null}
      unmountOnExit
      onCancel={() => controls.openPanel(null)}
    >
      {panel && (
        <div data-testid={`aelix-${panel}-drawer`}>
          <PanelBody controls={controls} panel={panel} />
        </div>
      )}
    </Drawer>
  );
};

/** Rows for the mobile composer's action sheet. Tapping closes the sheet and opens the drawer. */
export function aelixSheetEntries(t: TFunction, controls: Controls): MobileActionSheetEntry[] {
  if (!controls.enabled) return [];
  return [
    {
      key: 'aelix-profile',
      icon: <User theme='outline' size='16' />,
      label: t(`${KEY}.profile.label`),
      meta: controlSummary(t, controls, 'profile'),
      onClick: () => controls.openPanel('profile'),
    },
    {
      key: 'aelix-tools',
      icon: <Tool theme='outline' size='16' />,
      label: t(`${KEY}.tools.title`),
      meta: controlSummary(t, controls, 'tools'),
      onClick: () => controls.openPanel('tools'),
    },
  ];
}
