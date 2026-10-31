import type { RoomTemplate } from '@codesync/db'

const TEMPLATE_FILES: Record<RoomTemplate, Array<{ path: string; content: string }>> = {
  PYTHON: [{ path: 'main.py', content: 'print("Hello, CodeSync!")\n' }],
  CPP: [
    {
      path: 'main.cpp',
      content:
        '#include <iostream>\n\nint main() {\n    std::cout << "Hello, CodeSync!" << std::endl;\n    return 0;\n}\n',
    },
  ],
  JAVA: [
    {
      path: 'Main.java',
      content:
        'public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello, CodeSync!");\n    }\n}\n',
    },
  ],
  JAVASCRIPT: [{ path: 'main.js', content: 'console.log("Hello, CodeSync!")\n' }],
  BLANK: [],
}

export const templateFiles = (template: RoomTemplate): Array<{ path: string; content: string }> =>
  TEMPLATE_FILES[template]
