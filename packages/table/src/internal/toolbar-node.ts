import { isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";

export function sameBrunoTableToolbarNode(previous: ReactNode, next: ReactNode): boolean {
  if (Object.is(previous, next)) return true;
  if (isValidElement(previous) && isValidElement(next)) {
    if (previous.type !== next.type || previous.key !== next.key) return false;
    return sameToolbarProps(
      previous as ReactElement<Readonly<Record<string, unknown>>>,
      next as ReactElement<Readonly<Record<string, unknown>>>,
    );
  }
  if (Array.isArray(previous) && Array.isArray(next)) {
    return (
      previous.length === next.length &&
      previous.every((child, index) => sameBrunoTableToolbarNode(child, next[index]))
    );
  }
  return false;
}

function sameToolbarProps(
  previous: ReactElement<Readonly<Record<string, unknown>>>,
  next: ReactElement<Readonly<Record<string, unknown>>>,
): boolean {
  const previousKeys = Object.keys(previous.props);
  const nextKeys = Object.keys(next.props);
  if (previousKeys.length !== nextKeys.length) return false;
  return previousKeys.every((key) => {
    if (!Object.hasOwn(next.props, key)) return false;
    return key === "children"
      ? sameBrunoTableToolbarNode(previous.props[key] as ReactNode, next.props[key] as ReactNode)
      : Object.is(previous.props[key], next.props[key]);
  });
}
