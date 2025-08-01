import {
  Form,
  Input,
  Button,
  AutoComplete,
  Alert,
  Space
} from 'antd'
import { useEffect, useState } from 'react'
import Link from '../common/external-link'
import AiCache from './ai-cache'
import {
  aiConfigWikiLink
} from '../../common/constants'

// Comprehensive API provider configurations
import providers from './providers'

const e = window.translate
const defaultRoles = [
  {
    value: 'Terminal expert, provide commands for different OS, explain usage briefly, use markdown format'
  },
  {
    value: '终端专家,提供不同系统下命令,简要解释用法,用markdown格式'
  }
]

const proxyOptions = [
  { value: 'socks5://localhost:1080' },
  { value: 'http://localhost:8080' },
  { value: 'https://proxy.example.com:3128' }
]

export default function AIConfigForm ({ initialValues, onSubmit, showAIConfig }) {
  const [form] = Form.useForm()
  const [modelOptions, setModelOptions] = useState([])

  useEffect(() => {
    if (initialValues) {
      form.setFieldsValue(initialValues)
    }
  }, [initialValues])

  function filter () {
    return true
  }

  const getBaseURLOptions = () => {
    return providers.map(provider => ({
      value: provider.baseURL,
      label: provider.label
    }))
  }

  const getModelOptions = (baseURL) => {
    const provider = providers.find(p => p.baseURL === baseURL)
    if (!provider) return []

    return provider.models.map(model => ({
      value: model,
      label: model
    }))
  }

  const handleSubmit = async (values) => {
    onSubmit(values)
  }

  function handleChange (v) {
    const options = getModelOptions(v)
    setModelOptions(options)
    form.setFieldsValue({
      modelAI: options[0]?.value || ''
    })
  }

  if (!showAIConfig) {
    return null
  }
  const defaultLangs = window.store.getLangNames().map(l => ({ value: l }))
  return (
    <>
      <Alert
        message={
          <Link to={aiConfigWikiLink}>WIKI: {aiConfigWikiLink}</Link>
        }
        type='info'
        className='mg2y'
      />
      <p>
        Full Url: {initialValues?.baseURLAI}{initialValues?.apiPathAI}
      </p>
      <Form
        form={form}
        onFinish={handleSubmit}
        initialValues={initialValues}
        layout='vertical'
        className='ai-config-form'
      >
        <Form.Item label='API URL' required>
          <Space.Compact block>
            <Form.Item
              label='API URL'
              name='baseURLAI'
              noStyle
              rules={[
                { required: true, message: 'Please input or select API provider URL!' },
                { type: 'url', message: 'Please enter a valid URL!' }
              ]}
            >
              <AutoComplete
                options={getBaseURLOptions()}
                placeholder='Enter or select API provider URL'
                filterOption={filter}
                onChange={handleChange}
                allowClear
                style={{ width: '75%' }}
              />
            </Form.Item>
            <Form.Item
              label='API PATH'
              name='apiPathAI'
              rules={[
                { required: true, message: 'Please input API PATH' }
              ]}
              noStyle
            >
              <Input
                placeholder='/chat/completions'
                style={{ width: '25%' }}
              />
            </Form.Item>
          </Space.Compact>
        </Form.Item>
        <Form.Item
          label={e('modelAi')}
          name='modelAI'
          rules={[{ required: true, message: 'Please input or select a model!' }]}
        >
          <AutoComplete
            options={modelOptions}
            placeholder='Enter or select AI model'
            filterOption={filter}
          />
        </Form.Item>

        <Form.Item
          label='API Key'
          name='apiKeyAI'
        >
          <Input.Password placeholder='Enter your API key' />
        </Form.Item>

        <Form.Item
          label={e('roleAI')}
          name='roleAI'
          rules={[{ required: true, message: 'Please input the AI role!' }]}
        >
          <AutoComplete options={defaultRoles} placement='topLeft'>
            <Input.TextArea
              placeholder='Enter AI role/system prompt'
              rows={1}
            />
          </AutoComplete>
        </Form.Item>

        <Form.Item
          label={e('language')}
          name='languageAI'
          rules={[{ required: true, message: 'Please input language' }]}
        >
          <AutoComplete options={defaultLangs} placement='topLeft'>
            <Input
              placeholder={e('language')}
            />
          </AutoComplete>
        </Form.Item>

        <Form.Item
          label={e('proxy')}
          name='proxyAI'
          tooltip='Proxy for AI API requests (e.g., socks5://localhost:1080)'
        >
          <AutoComplete
            options={proxyOptions}
            placeholder='Enter proxy URL (optional)'
            filterOption={filter}
            allowClear
          >
            <Input />
          </AutoComplete>
        </Form.Item>

        <Form.Item>
          <Button type='primary' htmlType='submit'>
            {e('save')}
          </Button>
        </Form.Item>
      </Form>
      <AiCache />
    </>
  )
}
