import nextVitals from 'eslint-config-next/core-web-vitals';

const eslintConfig = [
	{
		ignores: ['.next-dev/**', '.next-e2e/**']
	},
	...nextVitals,
	{
		rules: {
			'react-hooks/set-state-in-effect': 'off',
			'react-hooks/static-components': 'off'
		}
	}
];

export default eslintConfig;