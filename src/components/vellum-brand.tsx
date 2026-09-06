// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.

interface BrandProps {
  alt?: string;
  className?: string;
  width: number;
  height: number;
}

function ResponsiveBrandAsset({
  alt = "",
  className = "",
  width,
  height,
  kind,
}: BrandProps & {
  kind: "mark" | "logo";
}) {
  const shared = `${className} h-auto`;
  return (
    <>
      <img
        src={`/brand/vellum-${kind}-on-light.svg`}
        alt={alt}
        width={width}
        height={height}
        className={`${shared} dark:hidden`}
      />
      <img
        src={`/brand/vellum-${kind}-on-dark.svg`}
        alt={alt}
        width={width}
        height={height}
        className={`${shared} hidden dark:block`}
      />
    </>
  );
}

export function VellumMark(props: BrandProps) {
  return <ResponsiveBrandAsset {...props} kind="mark" />;
}

export function VellumLogo(props: BrandProps) {
  return <ResponsiveBrandAsset {...props} kind="logo" />;
}
