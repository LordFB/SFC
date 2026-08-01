export type RouteDescriptor = {
  path: string;
  methods?: string[];
  auth?: boolean | string;
  meta?: Record<string, any>;
  lazy?: string | null;
  name?: string | null;
};
