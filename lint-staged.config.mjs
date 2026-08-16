export default {
  "*.{js,jsx,mjs,cjs,ts,tsx}": ["prettier --write", "eslint --fix --max-warnings 0"],
  "*.{css,scss,html,json,jsonc,md,mdx,yaml,yml,svg}": "prettier --write",
};
