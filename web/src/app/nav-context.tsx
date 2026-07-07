"use client";
// Lets a page's OWN fixed-position elements (e.g. /code's composer bar and sidebar,
// which hardcode left offsets sized to the global nav rail) react when the user
// hides that rail — otherwise collapsing the nav would leave a dead gap instead of
// letting those elements reflow into the reclaimed space.
import { createContext, useContext } from "react";

const NavCollapsedContext = createContext(false);
export const NavCollapsedProvider = NavCollapsedContext.Provider;
export function useNavCollapsed() {
  return useContext(NavCollapsedContext);
}
