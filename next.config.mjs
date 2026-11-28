/** @type {import("next").NextConfig} */
const nextConfig = {
  turbopack: {
    root: import.meta.dirname,
  },
  // The Creative Director's prompts are Markdown files read at runtime; ship them with every API route.
  outputFileTracingIncludes: {
    "/api/**": ["src/agents/creative-director/**/*.md"],
  },
};

export default nextConfig;
