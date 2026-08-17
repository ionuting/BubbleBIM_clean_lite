import React from 'react';
import ReactDOM from 'react-dom/client';
import { AppCleanLite } from './App';
import '../../src/index.css';
import './clean-theme.css';

// Dark ArchiCAD chrome by default; user toggle persists in localStorage.
const THEME_KEY = 'bubblebim_clean_theme';
const savedTheme = localStorage.getItem(THEME_KEY);
const preferDark = savedTheme ? savedTheme === 'dark' : true;
document.documentElement.classList.toggle('dark', preferDark);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppCleanLite />
  </React.StrictMode>
);
