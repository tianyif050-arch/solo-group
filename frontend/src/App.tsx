import { InterviewModeProvider } from '@/interviewMode'
import GroupInterview from '@/components/group/GroupInterview'
import SoloInterview from '@/components/solo/SoloInterview'
import HomePage from '@/pages/HomePage'
import GroupChatPage from '@/pages/GroupChatPage'
import GrowthPage from '@/pages/GrowthPage'
import GrowthRecordPage from '@/pages/GrowthRecordPage'
import ReportPage from '@/pages/ReportPage'
import SetupPage from '@/pages/SetupPage'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'

export default function App() {
  return (
    <InterviewModeProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/solo" element={<SoloInterview />} />
          <Route path="/group" element={<GroupInterview />} />
          <Route path="/group_chat" element={<GroupChatPage />} />
          <Route path="/report" element={<ReportPage />} />
          <Route path="/growth" element={<GrowthPage />} />
          <Route path="/growth/record/:id" element={<GrowthRecordPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </InterviewModeProvider>
  )
}
