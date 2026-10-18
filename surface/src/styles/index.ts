/**
 * Every stylesheet the window draws with, in cascade order: the self-hosted faces, the shell, then
 * the four destination sheets, each scoped under `[data-destination="..."]`. One list, imported by
 * the window's entry (`main.tsx`) and by anything else that draws the window's components, so a new
 * sheet cannot reach one and miss the other.
 */
import './fonts.css';
import './shell.css';
import './jira.css';
import './slack.css';
import './linear.css';
import './github.css';
