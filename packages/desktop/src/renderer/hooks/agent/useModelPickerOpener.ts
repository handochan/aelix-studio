/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useSyncExternalStore } from 'react';
import { useLatestRef } from '@/renderer/hooks/ui/useLatestRef';

/**
 * Lets an error card open the model picker of a conversation without knowing where it is drawn.
 *
 * A picker registers itself only while it can actually switch models: the header selector on
 * desktop, the send box action sheet on mobile. A card therefore knows whether its "Choose model"
 * would do anything. Opening only shows the picker; nothing is sent.
 */
type Opener = { open: () => void };

const openers = new Map<string, Opener[]>();
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const latestOpener = (conversationId: string): Opener | undefined => openers.get(conversationId)?.at(-1);

/** Opens the picker of the conversation; returns false when none can open. */
export const openModelPicker = (conversationId: string): boolean => {
  const opener = latestOpener(conversationId);
  opener?.open();
  return Boolean(opener);
};

/** Whether a picker that can switch models is currently shown for the conversation. */
export const useCanOpenModelPicker = (conversationId: string | undefined): boolean =>
  useSyncExternalStore(subscribe, () => Boolean(conversationId && latestOpener(conversationId)));

/** Registers `open` as the conversation's picker while it is defined. */
export const useModelPickerOpener = (conversationId: string, open: (() => void) | undefined): void => {
  const openRef = useLatestRef(open);
  const enabled = Boolean(open);
  useEffect(() => {
    if (!enabled) return;
    const opener: Opener = { open: () => openRef.current?.() };
    openers.set(conversationId, [...(openers.get(conversationId) ?? []), opener]);
    notify();
    return () => {
      const remaining = (openers.get(conversationId) ?? []).filter((item) => item !== opener);
      if (remaining.length > 0) openers.set(conversationId, remaining);
      else openers.delete(conversationId);
      notify();
    };
  }, [conversationId, enabled, openRef]);
};
