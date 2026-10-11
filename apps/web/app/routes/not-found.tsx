import { data } from "react-router";

/** Catch-all route: any unknown URL renders the root error boundary with a 404 status. */
export function loader() {
  throw data(null, { status: 404 });
}

export default function NotFound() {
  return null;
}
