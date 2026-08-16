// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { Modal } from "./modal";
import { Button } from "@/components/ui/button";

interface ConfirmProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  destructive?: boolean;
  pending?: boolean;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = "Confirm",
  destructive = false,
  pending = false,
}: ConfirmProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="plain" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "filled"}
            size="sm"
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? confirmLabel + "..." : confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm text-label-secondary">{message}</p>
    </Modal>
  );
}
