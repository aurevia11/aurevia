import type {Config} from 'tailwindcss';
const config:Config={darkMode:['class'],content:['./app/**/*.{ts,tsx}','./components/**/*.{ts,tsx}','./lib/**/*.{ts,tsx}'],theme:{extend:{colors:{gold:'#d4a72c',panel:'#111315',ink:'#090a0b',muted:'#8d939c',profit:'#31c48d',loss:'#f05252'}}},plugins:[]};
export default config;
